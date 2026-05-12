# CogniAccess — Claude Context File

Give this file to Claude at the start of any new session to restore full project context.

---

## Who Am I

- **Name**: Varsha Rani (Versha Rani)
- **Roll No**: 24MTCSE0009
- **Program**: M.Tech CSE, Dev Bhoomi Uttarakhand University
- **Supervisor**: Dr. Sumit Sharma
- **Email**: versha9917@gmail.com

---

## Project: CogniAccess

A web application that makes text accessible for people with dyslexia and cognitive reading difficulties.

**Live URL**: https://cogni-access.onrender.com  
**GitHub**: https://github.com/VershaRani-9917/cogni-access  
**Deployment**: Render.com (free tier)

### What It Does
- User pastes text → app analyses readability (difficulty score, Flesch–Kincaid grade)
- Detects difficult words and provides definitions from 3 sources:
  1. Custom dictionary (80+ hand-crafted definitions)
  2. Public CSV dataset
  3. WordNet (Princeton lexical database via NLTK)
- Shows "Simplified Text" with hover tooltips over difficult words
- ML model (Random Forest Regressor) learns from user hover behaviour → recommends optimal font size and line spacing
- User behaviour tracking (hover time, word length, session data)
- Settings modal (Profile, Preferences, Privacy tabs)
- Dark/light theme, dyslexic fonts (OpenDyslexic, Atkinson, Lexend, Comic Neue)
- PWA (installable as mobile app)
- Voice input (Web Speech API) and text-to-speech output

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.11, Flask 2.3+, SQLAlchemy |
| Database | PostgreSQL (Render managed, 90-day free) |
| ML | scikit-learn RandomForestRegressor, joblib |
| NLP | NLTK (punkt, stopwords, wordnet, POS tagger) |
| Text metrics | textstat (Flesch–Kincaid) |
| Frontend | Vanilla JS, Chart.js 4.4 |
| Fonts | Google Fonts (Inter, Atkinson, Lexend, Comic Neue) |
| Icons | Font Awesome 6.5 |
| Hosting | Render.com (free web service + free PostgreSQL) |

---

## File Structure

```
cogni-access/
├── app.py                  ← Flask app, all routes, ML, NLP
├── requirements.txt        ← Python dependencies
├── render.yaml             ← Render deploy config
├── setup_nltk.py           ← Downloads NLTK data to ./nltk_data/ during build
├── public_dataset.csv      ← Word definitions CSV (knowledge source #2)
├── font_model.pkl          ← Trained font-size RF model (created at runtime)
├── spacing_model.pkl       ← Trained spacing RF model (created at runtime)
├── static/
│   ├── script.js           ← All frontend JS (analysis, settings, charts, speech)
│   ├── style.css           ← All CSS (dark mode, dyslexic fonts, modals)
│   ├── manifest.json       ← PWA manifest
│   └── sw.js               ← Service worker
├── templates/
│   ├── index.html          ← Main app page
│   └── login.html          ← Login / Register page
└── CLAUDE_CONTEXT.md       ← This file
```

---

## Database Models

```python
User          — id, name, email, password_hash, created_at
UserBehavior  — id, timestamp, session_id, word, word_length, hover_time, font_size, line_spacing, difficulty_level
TextAnalysis  — id, timestamp, session_id, text_preview, difficulty_score, difficulty_level, word_count, sentence_count, difficult_word_count, readability_grade
```

---

## API Routes

| Method | Route | Description |
|--------|-------|-------------|
| GET/POST | `/login` | Login page |
| POST | `/register` | Create account |
| GET | `/logout` | Clear session |
| GET | `/` | Main app (login_required) |
| POST | `/analyze` | Main NLP analysis endpoint |
| POST | `/track_behavior` | Log hover event |
| GET | `/get_recommendation` | Get ML font/spacing recommendation |
| GET | `/dashboard_stats` | Analytics data |
| GET | `/api/profile` | Get user profile (login_required) |
| POST | `/api/update_name` | Change display name |
| POST | `/api/change_password` | Change password |
| POST | `/api/clear_behavior_data` | Wipe ML training data |
| POST | `/api/delete_account` | Delete account |
| GET | `/ping` | Keep-alive endpoint |

---

## Deployment Configuration (render.yaml)

```yaml
services:
  - type: web
    name: cogni-access
    env: python
    plan: free
    buildCommand: pip install -r requirements.txt && python setup_nltk.py
    startCommand: gunicorn app:app --bind 0.0.0.0:$PORT --workers 1 --timeout 120
    envVars:
      - key: PYTHON_VERSION
        value: 3.11.0
      - key: FLASK_ENV
        value: production
```

**Environment variables set in Render dashboard** (not in render.yaml for security):
- `DATABASE_URL` = postgresql://cogni_db_t1u5_user:...@dpg-d80pv0t7vvec73eehnvg-a/cogni_db_t1u5
- `SECRET_KEY` = (set if needed, defaults to hardcoded key in app.py)

---

## Key Known Issues & Fixes (History)

### Issue 1: Login fails after every redeploy (FIXED)
- **Cause**: Render free tier has ephemeral filesystem. SQLite DB wiped on every deploy.
- **Fix**: Migrated to PostgreSQL. URL rewrite `postgres://` → `postgresql://` in app.py. `psycopg2-binary` added to requirements.txt. `pool_pre_ping=True, pool_recycle=280` added to SQLAlchemy engine options.

### Issue 2: Analyze fails with "Analysis failed" error (FIXED)
- **Cause**: NLTK data (punkt, stopwords etc.) not reliably available at runtime on Render free tier.
- **Fix**: `setup_nltk.py` downloads NLTK data to `./nltk_data/` (project directory) during Render build. app.py inserts that path at front of `nltk.data.path`. Regex fallback tokenizers added. NLP processing wrapped in try/except.

### Issue 3: Stale session after DB wipe (FIXED)
- **Cause**: After DB wipe, old session cookie still has user_id but User.query.get() returns None → crash.
- **Fix**: `login_required` decorator checks if user still exists in DB; clears session and redirects if not. Returns JSON 401 for `/api/` routes.

### Issue 4: Settings modal not working (FIXED)
- **Cause**: Old `.nav-user-chip` CSS was for a div element, conflicted with button. Duplicate CSS block at bottom of style.css.
- **Fix**: Replaced with button-safe CSS, removed duplicate.

### Issue 5: 502 Bad Gateway on cold start (FIXED)
- **Cause**: PostgreSQL connection stale after Render free tier sleep.
- **Fix**: `pool_pre_ping=True` checks connection health before each query. `pool_recycle=280` recycles connections before Render's 300s idle timeout.

---

## Render Free Tier Limitations

- **Cold starts**: Service sleeps after 15 minutes of no traffic. First request takes 30-60 seconds.
- **Keep-alive**: JS `setInterval` pings `/ping` every 10 minutes when app is open in browser.
- **Workaround for 24/7 uptime**: Use UptimeRobot (free) to ping https://cogni-access.onrender.com/ping every 5 minutes. Sign up at uptimerobot.com.
- **PostgreSQL**: Free tier lasts 90 days from creation. After that, need to recreate.
- **Upgrade cost**: Render "Starter" plan = $7/month (~580 INR) → removes cold starts entirely.

---

## Writing Rules (IMPORTANT)

1. **Never use the word "hybrid"** in any writing about this project
2. Use **"Application"** not "system" when referring to CogniAccess
3. Write in **human-sounding, academic English** — not AI-sounding
4. **No plagiarism** — all writing must be original

---

## Pending Work

### 1. Research Paper
- Teacher rejected thesis because: diagrams looked AI-generated, content too short (needs 150+ pages)
- Needs: TikZ-only diagrams (no AI graphics), IIT-level academic writing
- Needs: Detailed cognitive disorder section, detailed application documentation
- Contact for guidance: Dr. Sumit Sharma (supervisor)

### 2. App Improvements (optional)
- History tab showing user's past analyses
- Forgot password flow (requires email SMTP setup)
- Better mobile responsiveness
- UptimeRobot keep-alive setup (free, external)

---

## How to Continue Development Locally

```bash
cd /Users/varshayadav/cogni-access
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python setup_nltk.py        # one-time NLTK download
python app.py               # runs on http://localhost:5001
```

## How to Deploy

```bash
git add .
git commit -m "Your message"
git push origin main
# Render auto-deploys from main branch — check Events tab
```
