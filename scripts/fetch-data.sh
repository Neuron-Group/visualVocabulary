#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/raw

NPEE_URL="https://raw.githubusercontent.com/mahavivo/english-wordlists/master/NPEE_Wordlist.txt"
ECDICT_URL="https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv"
GLOVE_URL="https://github.com/RaRe-Technologies/gensim-data/releases/download/glove-wiki-gigaword-100/glove-wiki-gigaword-100.gz"

[ -s data/raw/NPEE_Wordlist.txt ] || curl -fL --retry 3 "$NPEE_URL" -o data/raw/NPEE_Wordlist.txt
[ -s data/raw/ecdict.csv ] || curl -fL --retry 3 "$ECDICT_URL" -o data/raw/ecdict.csv
[ -s data/raw/glove100.gz ] || curl -fL --retry 3 "$GLOVE_URL" -o data/raw/glove100.gz

node scripts/build-data.mjs
