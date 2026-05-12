"""Run during Render build to bake NLTK data into the project directory.
Never raises — a download failure just means that resource falls back to
NLTK's default download path at runtime, or to the in-code fallback."""
import os
import sys
import nltk

NLTK_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nltk_data")
os.makedirs(NLTK_DIR, exist_ok=True)

# punkt_tab and averaged_perceptron_tagger* are nice-to-have but not required.
RESOURCES = [
    "stopwords",        # critical – used at module level
    "wordnet",          # definitions
    "punkt",            # sentence/word tokenisation
    "punkt_tab",        # newer punkt format
]

ok, fail = [], []
for res in RESOURCES:
    try:
        nltk.download(res, download_dir=NLTK_DIR, quiet=False)
        ok.append(res)
    except Exception as e:
        fail.append(res)
        print(f"WARNING: could not download {res}: {e}", file=sys.stderr)

print(f"NLTK setup done. OK={ok}  FAILED={fail}")
print(f"Data dir: {NLTK_DIR}")
