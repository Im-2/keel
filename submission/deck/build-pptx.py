"""submission/keel-deck.pptx from the rendered slides: one full-bleed image per slide, slide text in the notes.
Run after build.mjs:  python submission/deck/build-pptx.py   (needs python-pptx)"""
import json, os
from pptx import Presentation
from pptx.util import Emu

here = os.path.dirname(os.path.abspath(__file__))
slides = sorted(f for f in os.listdir(os.path.join(here, "slides")) if f.endswith(".png"))
notes = json.load(open(os.path.join(here, "slides", "notes.json"), encoding="utf8"))
prs = Presentation()
prs.slide_width, prs.slide_height = Emu(12192000), Emu(6858000)  # 16:9
for i, f in enumerate(slides):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    s.shapes.add_picture(os.path.join(here, "slides", f), 0, 0, prs.slide_width, prs.slide_height)
    s.notes_slide.notes_text_frame.text = notes[i] if i < len(notes) else ""
prs.save(os.path.join(here, "..", "keel-deck.pptx"))
print(f"keel-deck.pptx: {len(slides)} slides")
