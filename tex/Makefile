PDF = 6502life.pdf
SRC = 6502life.tex refs.bib
OUTDIR = ../doc

.PHONY: all clean

all: $(OUTDIR)/6502life-spec.pdf

$(PDF): $(SRC)
	pdflatex -interaction=nonstopmode 6502life.tex
	pdflatex -interaction=nonstopmode 6502life.tex

$(OUTDIR)/6502life-spec.pdf: $(PDF) | $(OUTDIR)
	cp $(PDF) $(OUTDIR)/6502life-spec.pdf

$(OUTDIR):
	mkdir -p $(OUTDIR)

clean:
	rm -f *.aux *.log *.out *.bbl *.blg *.toc *.pdf
