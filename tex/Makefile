PDFS = 6502life.pdf distance.pdf
SRC = 6502life.tex distance.tex refs.bib
OUTDIR = ../doc

.PHONY: all clean

all: $(OUTDIR)/6502life.pdf $(OUTDIR)/distance.pdf

6502life.pdf: 6502life.tex refs.bib
	pdflatex -interaction=nonstopmode 6502life.tex
	bibtex 6502life || true
	pdflatex -interaction=nonstopmode 6502life.tex
	pdflatex -interaction=nonstopmode 6502life.tex

distance.pdf: distance.tex
	pdflatex -interaction=nonstopmode distance.tex
	pdflatex -interaction=nonstopmode distance.tex

$(OUTDIR)/6502life.pdf: 6502life.pdf | $(OUTDIR)
	cp 6502life.pdf $(OUTDIR)/6502life.pdf

$(OUTDIR)/distance.pdf: distance.pdf | $(OUTDIR)
	cp distance.pdf $(OUTDIR)/distance.pdf

$(OUTDIR):
	mkdir -p $(OUTDIR)

clean:
	rm -f *.aux *.log *.out *.bbl *.blg *.toc *.pdf
