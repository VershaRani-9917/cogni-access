"""Run during Render build to bake NLTK data into the project directory."""
import os
import nltk

NLTK_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nltk_data")
os.makedirs(NLTK_DIR, exist_ok=True)

RESOURCES = [
    "punkt", "punkt_tab", "stopwords",
    "wordnet", "averaged_perceptron_tagger", "averaged_perceptron_tagger_eng",
]
for res in RESOURCES:
    print(f"Downloading {res} …", flush=True)
    nltk.download(res, download_dir=NLTK_DIR, quiet=False)

print("NLTK data ready in", NLTK_DIR)
