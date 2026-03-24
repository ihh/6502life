#!/bin/bash
# Build all LaTeX documents and copy PDFs to doc/
set -e
cd "$(dirname "$0")"

echo "Building 6502life.tex..."
pdflatex -interaction=nonstopmode 6502life.tex
bibtex 6502life || true
pdflatex -interaction=nonstopmode 6502life.tex
pdflatex -interaction=nonstopmode 6502life.tex

echo "Building distance.tex..."
pdflatex -interaction=nonstopmode distance.tex
pdflatex -interaction=nonstopmode distance.tex

echo "Copying PDFs to doc/..."
cp 6502life.pdf distance.pdf ../doc/

echo "Done."
