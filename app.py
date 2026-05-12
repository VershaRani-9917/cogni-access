import os
import csv
import re
import uuid
import string
import datetime
from functools import wraps

import nltk
# Point NLTK at the bundled data directory first (baked in during Render build)
_NLTK_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nltk_data")
if os.path.isdir(_NLTK_DATA_DIR):
    nltk.data.path.insert(0, _NLTK_DATA_DIR)

import numpy as np
import pandas as pd
import joblib
import textstat
from flask import Flask, request, jsonify, render_template, session, redirect, url_for, flash
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
from sklearn.ensemble import RandomForestRegressor
from nltk.corpus import stopwords, wordnet
from nltk.tokenize import sent_tokenize, word_tokenize

for _res in ["punkt", "punkt_tab", "stopwords", "wordnet",
             "averaged_perceptron_tagger", "averaged_perceptron_tagger_eng"]:
    try:
        nltk.download(_res, quiet=True, raise_on_error=False)
    except Exception:
        pass

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_URL = os.environ.get("DATABASE_URL", f"sqlite:///{os.path.join(BASE_DIR, 'cogni_access.db')}")
# Render.com provides postgres:// but SQLAlchemy 1.4+ requires postgresql://
if DB_URL.startswith("postgres://"):
    DB_URL = DB_URL.replace("postgres://", "postgresql://", 1)
app.config["SQLALCHEMY_DATABASE_URI"] = DB_URL
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "cogni-access-secret-2026-varsha")
# Keep PostgreSQL connections alive across requests on free tier
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
    "pool_pre_ping": True,
    "pool_recycle": 280,
}

db = SQLAlchemy(app)

FONT_MODEL_PATH  = os.path.join(BASE_DIR, "font_model.pkl")
SPACE_MODEL_PATH = os.path.join(BASE_DIR, "spacing_model.pkl")
DATASET_PATH     = os.path.join(BASE_DIR, "public_dataset.csv")

# In-memory model cache — avoids reloading pkl from disk on every request
_model_cache = {"font": None, "space": None, "n_pts": 0}

# ── Auth Helper ───────────────────────────────────────────────────────────────
def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        is_api = request.path.startswith("/api/")
        if "user_id" not in session:
            if is_api:
                return jsonify({"error": "Not authenticated"}), 401
            return redirect(url_for("login_page"))
        # Guard against stale session after DB wipe (Render ephemeral filesystem)
        if User.query.get(session["user_id"]) is None:
            session.clear()
            if is_api:
                return jsonify({"error": "Session expired — please sign in again"}), 401
            flash("Your session expired — please sign in again.", "error")
            return redirect(url_for("login_page"))
        return f(*args, **kwargs)
    return decorated

# ── Database Models ────────────────────────────────────────────────────────────
class User(db.Model):
    __tablename__ = "users"
    id            = db.Column(db.Integer, primary_key=True)
    name          = db.Column(db.String(100), nullable=False)
    email         = db.Column(db.String(150), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(256), nullable=False)
    created_at    = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    avatar_style  = db.Column(db.Integer, default=0)

class UserBehavior(db.Model):
    __tablename__ = "user_behavior"
    id             = db.Column(db.Integer, primary_key=True)
    timestamp      = db.Column(db.DateTime, default=datetime.datetime.utcnow, index=True)
    session_id     = db.Column(db.String(64), index=True)
    word           = db.Column(db.String(100))
    word_length    = db.Column(db.Integer)
    hover_time     = db.Column(db.Float)
    font_size      = db.Column(db.Float)
    line_spacing   = db.Column(db.Float)
    difficulty_level = db.Column(db.String(20))

class TextAnalysis(db.Model):
    __tablename__ = "text_analysis"
    id                  = db.Column(db.Integer, primary_key=True)
    timestamp           = db.Column(db.DateTime, default=datetime.datetime.utcnow, index=True)
    session_id          = db.Column(db.String(64), index=True)
    text_preview        = db.Column(db.String(300))
    difficulty_score    = db.Column(db.Float)
    difficulty_level    = db.Column(db.String(20))
    word_count          = db.Column(db.Integer)
    sentence_count      = db.Column(db.Integer)
    difficult_word_count= db.Column(db.Integer)
    readability_grade   = db.Column(db.Float)

with app.app_context():
    db.create_all()
    # Add avatar_style column to existing users table if it doesn't exist yet
    try:
        with db.engine.connect() as _conn:
            _conn.execute(text("ALTER TABLE users ADD COLUMN avatar_style INTEGER DEFAULT 0"))
            _conn.commit()
    except Exception:
        pass

# ── Custom Dictionary ──────────────────────────────────────────────────────────
CUSTOM_DICTIONARY = {
    "accessibility": "making things easy to use for everyone",
    "accessible": "easy for people to use or understand",
    "disability": "a condition that makes some activities harder",
    "cognitive": "related to thinking and understanding",
    "dyslexia": "a reading difficulty affecting letter recognition",
    "neurodiversity": "the range of differences in individual brain function",
    "algorithm": "a step-by-step method to solve a problem",
    "artificial": "made by humans, not natural",
    "intelligence": "ability to learn and understand",
    "technology": "tools created using science",
    "interface": "the way a user interacts with a system",
    "abbreviate": "to shorten a word or text",
    "abnormal": "different from what is usual",
    "abstract": "an idea not based on physical things",
    "accelerate": "to go faster",
    "accomplish": "to successfully finish something",
    "accurate": "correct and without mistakes",
    "adjacent": "next to or near something",
    "aggregate": "a total amount made up of many parts",
    "allocate": "to give out or assign something",
    "ambiguous": "having more than one meaning",
    "analyze": "to examine something carefully",
    "annotate": "to add notes to a text",
    "anonymous": "having no known name",
    "apparatus": "equipment used for a specific purpose",
    "arbitrary": "chosen randomly without a clear reason",
    "architect": "a person who designs buildings",
    "authentic": "real and genuine, not fake",
    "authorize": "to give official permission",
    "automatic": "working by itself without human help",
    "calculate": "to find an answer using math",
    "capacity": "the maximum amount something can hold",
    "catastrophe": "a terrible disaster",
    "coherent": "logically connected and clear",
    "coincidence": "two things happening at the same time by chance",
    "collaborate": "to work together with others",
    "comprehend": "to fully understand something",
    "consecutive": "following one after another without a break",
    "consistent": "always behaving the same way",
    "contradict": "to say the opposite of something",
    "correlation": "a connection between two things",
    "demonstrate": "to show how something works",
    "determine": "to find out or decide something",
    "distribute": "to give something out to many people",
    "elaborate": "to give more detail or explanation",
    "eliminate": "to completely remove something",
    "emphasize": "to give special importance to something",
    "establish": "to set up or create something",
    "evaluate": "to judge the value of something",
    "exaggerate": "to make something seem bigger than it is",
    "facilitate": "to make something easier",
    "formulate": "to create or develop a plan",
    "fundamental": "basic and most important",
    "generate": "to produce or create something",
    "hypothesis": "a guess that needs to be tested",
    "identical": "exactly the same",
    "illuminate": "to light up or make clear",
    "implement": "to put a plan into action",
    "inadequate": "not enough or good enough",
    "interpret": "to explain or understand the meaning",
    "investigate": "to look into something carefully",
    "justify": "to give a reason for something",
    "maintain": "to keep something in good condition",
    "maximize": "to make as large as possible",
    "mechanism": "a system of parts that work together",
    "minimize": "to make as small as possible",
    "multitude": "a very large number of things",
    "negotiate": "to discuss to reach an agreement",
    "objective": "a goal you are trying to achieve",
    "participate": "to take part in something",
    "perceive": "to become aware of something",
    "phenomenon": "a remarkable or unusual event",
    "predominant": "most common or important",
    "prioritize": "to decide what is most important",
    "procedure": "a set of steps for doing something",
    "proficiency": "skill and expertise in something",
    "reconcile": "to restore a friendly relationship",
    "reinforce": "to strengthen or support something",
    "represent": "to stand for or act on behalf of",
    "significant": "important or meaningful",
    "specific": "clearly defined or particular",
    "sufficient": "enough for what is needed",
    "summarize": "to give a brief overview",
    "theoretical": "based on ideas rather than practice",
    "transform": "to completely change something",
    "transparent": "easy to see through; open and honest",
    "ultimately": "in the end; finally",
    "understand": "to know the meaning of something",
    "utilize": "to make use of something",
    "validate": "to confirm that something is correct",
    "variation": "a difference or change in something",
    "education": "the process of teaching and learning",
    "research": "careful study to discover new information",
    "experiment": "a test done to discover something",
    "information": "facts or knowledge about something",
    "behavior": "the way a person acts or responds",
    "simplify": "make something easier to understand",
    "communication": "sharing information with others",
    "development": "the process of growth or progress",
    "experience": "knowledge gained through practice",
    "feedback": "information about performance",
    "debate": "a discussion where people have different opinions",
    "appropriate": "suitable or correct for a situation",
    "pompous": "acting as if more important than others",
    "mundane": "ordinary and not interesting",
    "dataset": "a collection of related data",
    "prediction": "a guess about what will happen",
}

# ── Dataset Loader ─────────────────────────────────────────────────────────────
def load_public_dataset():
    dataset = {}
    if not os.path.exists(DATASET_PATH):
        return dataset
    with open(DATASET_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            word = row.get("word", "").strip().lower()
            defn = row.get("definition", row.get("hint", "")).strip()
            if word and defn:
                dataset[word] = defn
    return dataset

PUBLIC_DATASET = load_public_dataset()

def wordnet_definition(word):
    try:
        synsets = wordnet.synsets(word)
        return synsets[0].definition() if synsets else None
    except Exception:
        return None

def get_definition(word):
    key = word.lower()
    if key in CUSTOM_DICTIONARY:
        return CUSTOM_DICTIONARY[key], "custom"
    if key in PUBLIC_DATASET:
        return PUBLIC_DATASET[key], "dataset"
    defn = wordnet_definition(key)
    if defn:
        return defn, "wordnet"
    return None, None

# ── Text Processing ────────────────────────────────────────────────────────────
# Hardcoded fallback so the app starts even if NLTK stopwords are unavailable
_STOPWORDS_FALLBACK = frozenset([
    "i","me","my","myself","we","our","ours","ourselves","you","your","yours",
    "yourself","yourselves","he","him","his","himself","she","her","hers","herself",
    "it","its","itself","they","them","their","theirs","themselves","what","which",
    "who","whom","this","that","these","those","am","is","are","was","were","be",
    "been","being","have","has","had","having","do","does","did","doing","a","an",
    "the","and","but","if","or","because","as","until","while","of","at","by",
    "for","with","about","against","between","into","through","during","before",
    "after","above","below","to","from","up","down","in","out","on","off","over",
    "under","again","further","then","once","here","there","when","where","why",
    "how","all","both","each","few","more","most","other","some","such","no","nor",
    "not","only","own","same","so","than","too","very","s","t","can","will","just",
    "don","should","now","d","ll","m","o","re","ve","y","ain","aren","couldn",
    "didn","doesn","hadn","hasn","haven","isn","ma","mightn","mustn","needn","shan",
    "shouldn","wasn","weren","won","wouldn",
])
try:
    STOP_WORDS = set(stopwords.words("english"))
except Exception:
    STOP_WORDS = set(_STOPWORDS_FALLBACK)

def _safe_sent_tokenize(text):
    try:
        return sent_tokenize(text)
    except Exception:
        return re.split(r'(?<=[.!?])\s+', text) or [text]

def _safe_word_tokenize(text):
    try:
        return word_tokenize(text)
    except Exception:
        return re.findall(r"[A-Za-z']+|[^\w\s]", text)

def preprocess_text(raw_text):
    cleaned   = " ".join(raw_text.split())
    sentences = _safe_sent_tokenize(cleaned)
    words     = _safe_word_tokenize(cleaned)
    alpha     = [w for w in words if w.isalpha()]

    avg_word_len = (sum(len(w) for w in alpha) / len(alpha)) if alpha else 0
    avg_sent_len = (len(alpha) / len(sentences)) if sentences else 0
    score        = round(0.5 * avg_word_len + 0.3 * avg_sent_len, 2)

    try:
        grade = textstat.flesch_kincaid_grade(cleaned)
        ease  = textstat.flesch_reading_ease(cleaned)
    except Exception:
        grade, ease = 0, 0

    level = "Easy" if score < 6 else "Medium" if score <= 10 else "Hard"

    return {
        "cleaned_text":    cleaned,
        "sentences":       sentences,
        "alpha_words":     alpha,
        "avg_word_len":    avg_word_len,
        "avg_sent_len":    avg_sent_len,
        "difficulty_score": score,
        "difficulty_level": level,
        "flesch_grade":    round(grade, 1),
        "readability_ease": round(ease, 1),
    }

def detect_difficult_words(alpha_words):
    seen, difficult = set(), {}
    for word in alpha_words:
        lower = word.lower()
        if lower in seen or lower in STOP_WORDS or len(lower) <= 6:
            continue
        defn, source = get_definition(lower)
        if defn:
            difficult[lower] = {"definition": defn, "source": source}
        seen.add(lower)
    return difficult

# ── HTML Builders ──────────────────────────────────────────────────────────────
def _detokenize(tokens):
    text = ""
    for i, tok in enumerate(tokens):
        if i == 0 or tok in string.punctuation:
            text += tok
        else:
            text += " " + tok
    return text

def build_highlighted_html(text, difficult_words):
    result = []
    for token in word_tokenize(text):
        lower = token.lower()
        if lower in difficult_words and token.isalpha():
            defn = difficult_words[lower]["definition"].replace('"', "&quot;")
            result.append(f'<mark class="highlight-word" title="{defn}">{token}</mark>')
        else:
            result.append(token)
    return _detokenize(result)

def build_tooltip_html(text, difficult_words):
    result = []
    for token in word_tokenize(text):
        lower = token.lower()
        if lower in difficult_words and token.isalpha():
            defn   = difficult_words[lower]["definition"].replace('"', "&quot;")
            source = difficult_words[lower]["source"]
            result.append(
                f'<span class="tooltip-word" data-word-length="{len(token)}" '
                f'data-definition="{defn}" data-source="{source}">{token}'
                f'<span class="tooltip-box">'
                f'<span class="tt-source tt-{source}">{source}</span>'
                f'{defn}</span></span>'
            )
        else:
            result.append(token)
    return _detokenize(result)

# ── Machine Learning ───────────────────────────────────────────────────────────
def _get_df():
    rows = UserBehavior.query.filter(
        UserBehavior.hover_time.isnot(None),
        UserBehavior.word_length.isnot(None),
    ).all()
    if len(rows) < 5:
        return None
    return pd.DataFrame([{
        "word_length":  r.word_length,
        "hover_time":   r.hover_time,
        "font_size":    r.font_size,
        "line_spacing": r.line_spacing,
    } for r in rows])

def train_models():
    df = _get_df()
    if df is None:
        return False
    X = df[["word_length", "hover_time"]].values
    rf_font = RandomForestRegressor(n_estimators=20, random_state=42)
    rf_font.fit(X, df["font_size"].values)
    rf_space = RandomForestRegressor(n_estimators=20, random_state=42)
    rf_space.fit(X, df["line_spacing"].values)
    # cache in memory
    _model_cache["font"]  = rf_font
    _model_cache["space"] = rf_space
    _model_cache["n_pts"] = len(df)
    # persist to disk (best-effort)
    try:
        joblib.dump(rf_font,  FONT_MODEL_PATH)
        joblib.dump(rf_space, SPACE_MODEL_PATH)
    except Exception:
        pass
    return True

def train_and_predict():
    defaults = {"font_size": 20, "line_spacing": 1.5}
    df = _get_df()
    if df is None:
        return defaults, 0

    n_pts = len(df)

    # Use cached model if already trained
    if _model_cache["font"] is None:
        # Try loading from disk first
        if os.path.exists(FONT_MODEL_PATH) and os.path.exists(SPACE_MODEL_PATH):
            try:
                _model_cache["font"]  = joblib.load(FONT_MODEL_PATH)
                _model_cache["space"] = joblib.load(SPACE_MODEL_PATH)
            except Exception:
                pass
        # If still None, train now
        if _model_cache["font"] is None:
            if not train_models():
                return defaults, n_pts

    try:
        x = np.array([[df["word_length"].mean(), df["hover_time"].mean()]])
        font  = max(14, min(40, round(float(_model_cache["font"].predict(x)[0]),  1)))
        space = max(1.0, min(3.0, round(float(_model_cache["space"].predict(x)[0]), 2)))
    except Exception:
        return defaults, n_pts

    return {"font_size": font, "line_spacing": space}, n_pts

# ── Auth Routes ────────────────────────────────────────────────────────────────
@app.route("/login", methods=["GET", "POST"])
def login_page():
    if "user_id" in session:
        return redirect(url_for("index"))
    if request.method == "POST":
        email    = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        user     = User.query.filter_by(email=email).first()
        if user and check_password_hash(user.password_hash, password):
            session["user_id"]   = user.id
            session["user_name"] = user.name
            return redirect(url_for("index"))
        flash("Incorrect email or password. Please try again.", "error")
    return render_template("login.html")

@app.route("/register", methods=["POST"])
def register():
    name     = request.form.get("name", "").strip()
    email    = request.form.get("email", "").strip().lower()
    password = request.form.get("password", "")
    if not name or not email or not password:
        flash("All fields are required.", "error")
        return render_template("login.html", active_tab="register")
    if len(password) < 6:
        flash("Password must be at least 6 characters.", "error")
        return render_template("login.html", active_tab="register")
    if User.query.filter_by(email=email).first():
        flash("An account with this email already exists. Please sign in.", "error")
        return render_template("login.html", active_tab="register")
    user = User(name=name, email=email, password_hash=generate_password_hash(password, method='pbkdf2:sha256'))
    db.session.add(user)
    db.session.commit()
    session["user_id"]   = user.id
    session["user_name"] = user.name
    return redirect(url_for("index"))

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login_page"))

# ── Routes ─────────────────────────────────────────────────────────────────────
@app.route("/")
@login_required
def index():
    user = User.query.get(session["user_id"])
    return render_template("index.html",
        user_name=session.get("user_name", "User"),
        avatar_style=user.avatar_style if user and user.avatar_style is not None else 0,
    )

@app.route("/analyze", methods=["POST"])
def analyze():
    data       = request.get_json(force=True)
    raw_text   = data.get("text", "").strip()
    session_id = data.get("session_id", str(uuid.uuid4()))

    if not raw_text:
        return jsonify({"error": "No text provided"}), 400

    try:
        processed       = preprocess_text(raw_text)
        difficult_words = detect_difficult_words(processed["alpha_words"])
        highlighted     = build_highlighted_html(processed["cleaned_text"], difficult_words)
        simplified      = build_tooltip_html(processed["cleaned_text"], difficult_words)
        sources         = list(set(v["source"] for v in difficult_words.values()))
    except Exception as exc:
        return jsonify({"error": f"Text processing failed: {exc}"}), 500

    # Use cached recommendation — avoids slow DB query on every analyze
    if _model_cache["font"] is not None:
        rec, n_pts = train_and_predict()
    else:
        rec    = {"font_size": 20, "line_spacing": 1.5}
        n_pts  = _model_cache["n_pts"]

    try:
        record = TextAnalysis(
            session_id=session_id,
            text_preview=raw_text[:300],
            difficulty_score=processed["difficulty_score"],
            difficulty_level=processed["difficulty_level"],
            word_count=len(processed["alpha_words"]),
            sentence_count=len(processed["sentences"]),
            difficult_word_count=len(difficult_words),
            readability_grade=processed["flesch_grade"],
        )
        db.session.add(record)
        db.session.commit()
    except Exception:
        db.session.rollback()

    return jsonify({
        "difficulty_score":    processed["difficulty_score"],
        "difficulty_level":    processed["difficulty_level"],
        "flesch_grade":        processed["flesch_grade"],
        "readability_ease":    processed["readability_ease"],
        "highlighted_html":    highlighted,
        "simplified_html":     simplified,
        "recommended_font":    rec["font_size"],
        "recommended_spacing": rec["line_spacing"],
        "tooltip_words":       list(difficult_words.keys()),
        "sources_used":        sources,
        "word_count":          len(processed["alpha_words"]),
        "sentence_count":      len(processed["sentences"]),
        "difficult_word_count": len(difficult_words),
        "data_points":         n_pts,
    })

@app.route("/track_behavior", methods=["POST"])
def track_behavior():
    data = request.get_json(force=True)
    try:
        record = UserBehavior(
            session_id=data.get("session_id", str(uuid.uuid4())),
            word=data.get("word", ""),
            word_length=data.get("word_length", 0),
            hover_time=data.get("hover_time", 0),
            font_size=data.get("font_size", 20),
            line_spacing=data.get("line_spacing", 1.5),
            difficulty_level=data.get("difficulty_level", ""),
        )
        db.session.add(record)
        db.session.commit()
    except Exception:
        db.session.rollback()

    count = UserBehavior.query.count()
    retrained = False
    if count % 10 == 0:
        retrained = train_models()

    # Only recompute recommendation when retrained or cache is warm
    if retrained or _model_cache["font"] is not None:
        rec, n_pts = train_and_predict()
    else:
        rec   = {"font_size": 20, "line_spacing": 1.5}
        n_pts = count

    return jsonify({"status": "ok", "data_points": n_pts, "updated_recommendation": rec})

@app.route("/get_recommendation", methods=["GET"])
def get_recommendation():
    rec, n_pts = train_and_predict()
    return jsonify({**rec, "data_points": n_pts})

@app.route("/dashboard_stats", methods=["GET"])
def dashboard_stats():
    total      = TextAnalysis.query.count()
    behaviors  = UserBehavior.query.count()
    sessions   = db.session.query(TextAnalysis.session_id).distinct().count()
    easy       = TextAnalysis.query.filter_by(difficulty_level="Easy").count()
    medium     = TextAnalysis.query.filter_by(difficulty_level="Medium").count()
    hard       = TextAnalysis.query.filter_by(difficulty_level="Hard").count()

    recent_rows = TextAnalysis.query.order_by(TextAnalysis.timestamp.desc()).limit(10).all()
    recent = [{"time": r.timestamp.strftime("%H:%M"), "score": r.difficulty_score,
               "level": r.difficulty_level, "words": r.word_count} for r in recent_rows]

    brows  = UserBehavior.query.order_by(UserBehavior.timestamp.desc()).limit(50).all()
    hovers = [round(b.hover_time, 2) for b in brows if b.hover_time]
    avg_h  = round(sum(hovers) / len(hovers), 2) if hovers else 0
    avg_d  = db.session.query(db.func.avg(TextAnalysis.difficulty_score)).scalar() or 0

    return jsonify({
        "total_analyses": total,
        "total_behaviors": behaviors,
        "sessions": sessions,
        "avg_difficulty": round(float(avg_d), 2),
        "avg_hover_time": avg_h,
        "difficulty_distribution": {"Easy": easy, "Medium": medium, "Hard": hard},
        "recent_analyses": recent,
        "hover_data": hovers[-20:],
    })

# ── User Settings API ─────────────────────────────────────────────────────────
@app.route("/api/profile", methods=["GET"])
@login_required
def api_profile():
    user = User.query.get(session["user_id"])
    return jsonify({
        "name":           user.name,
        "email":          user.email,
        "created_at":     user.created_at.strftime("%B %Y"),
        "analysis_count": TextAnalysis.query.count(),
        "behavior_count": UserBehavior.query.count(),
        "avatar_style":   user.avatar_style if user.avatar_style is not None else 0,
    })

@app.route("/api/update_avatar", methods=["POST"])
@login_required
def api_update_avatar():
    style = request.get_json(force=True).get("style", 0)
    try:
        style = max(0, min(9, int(style)))
    except (TypeError, ValueError):
        style = 0
    user = User.query.get(session["user_id"])
    user.avatar_style = style
    db.session.commit()
    return jsonify({"ok": True, "style": style})

@app.route("/api/update_name", methods=["POST"])
@login_required
def api_update_name():
    name = request.get_json(force=True).get("name", "").strip()
    if not name:
        return jsonify({"error": "Name cannot be empty"}), 400
    user = User.query.get(session["user_id"])
    user.name = name
    db.session.commit()
    session["user_name"] = name
    return jsonify({"ok": True, "name": name})

@app.route("/api/change_password", methods=["POST"])
@login_required
def api_change_password():
    data    = request.get_json(force=True)
    current = data.get("current_password", "")
    new_pw  = data.get("new_password", "")
    user = User.query.get(session["user_id"])
    if not check_password_hash(user.password_hash, current):
        return jsonify({"error": "Current password is incorrect"}), 400
    if len(new_pw) < 6:
        return jsonify({"error": "New password must be at least 6 characters"}), 400
    user.password_hash = generate_password_hash(new_pw, method="pbkdf2:sha256")
    db.session.commit()
    return jsonify({"ok": True})

@app.route("/api/clear_behavior_data", methods=["POST"])
@login_required
def api_clear_behavior_data():
    UserBehavior.query.delete()
    db.session.commit()
    _model_cache["font"]  = None
    _model_cache["space"] = None
    _model_cache["n_pts"] = 0
    return jsonify({"ok": True})

@app.route("/api/delete_account", methods=["POST"])
@login_required
def api_delete_account():
    password = request.get_json(force=True).get("password", "")
    user = User.query.get(session["user_id"])
    if not check_password_hash(user.password_hash, password):
        return jsonify({"error": "Incorrect password"}), 400
    db.session.delete(user)
    db.session.commit()
    session.clear()
    return jsonify({"ok": True})

@app.route("/ping")
def ping():
    return jsonify({"status": "ok"}), 200

if __name__ == "__main__":
    app.run(debug=True, port=5001)
