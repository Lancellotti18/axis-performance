"""
Realistic contractor-grade blueprint PDFs for BuildAI testing.
Uses proper architectural conventions: wall thickness, hatch fills,
dimension strings, schedules, notes, title blocks, north arrows.
"""
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib import colors
from reportlab.lib.units import inch
import math, os

OUT = os.path.expanduser("~/Desktop/test_blueprints")
os.makedirs(OUT, exist_ok=True)

PW, PH = landscape(letter)   # 792 x 612
WALL = 6                      # wall thickness pts (~6")
THIN = 0.4
MED  = 0.8
BOLD = 1.8
XBOLD= 3.0

# ── Color palette ──────────────────────────────────────────────
C_WALL   = colors.black
C_DIM    = colors.Color(0.15, 0.15, 0.55)
C_HATCH  = colors.Color(0.35, 0.35, 0.35)
C_ELEC   = colors.Color(0.7, 0.4, 0)
C_PLUMB  = colors.Color(0, 0.35, 0.7)
C_TEXT   = colors.black
C_GRID   = colors.Color(0.88, 0.88, 0.93)
C_NOTE   = colors.Color(0.6, 0, 0)
C_NEW    = colors.Color(0.1, 0.45, 0.1)
C_CENTER = colors.Color(0.5, 0.5, 0.5)

# ═══════════════════════════════════════════════════════════════
# PRIMITIVES
# ═══════════════════════════════════════════════════════════════

def bg_grid(c, step=18):
    c.setStrokeColor(C_GRID)
    c.setLineWidth(0.25)
    for x in range(0, int(PW), step):
        c.line(x, 0, x, PH)
    for y in range(0, int(PH), step):
        c.line(0, y, PW, y)

def thick_wall(c, x1, y1, x2, y2, t=WALL):
    """Draw a filled double-line wall."""
    import math
    dx, dy = x2 - x1, y2 - y1
    L = math.hypot(dx, dy)
    if L == 0: return
    nx, ny = -dy / L * t / 2, dx / L * t / 2
    pts = [
        (x1 + nx, y1 + ny), (x2 + nx, y2 + ny),
        (x2 - nx, y2 - ny), (x1 - nx, y1 - ny)
    ]
    c.setFillColor(C_HATCH)
    c.setStrokeColor(C_WALL)
    c.setLineWidth(MED)
    p = c.beginPath()
    p.moveTo(*pts[0])
    for pt in pts[1:]: p.lineTo(*pt)
    p.close()
    c.drawPath(p, fill=1, stroke=1)

def wall_h(c, x, y, w, t=WALL):
    thick_wall(c, x, y, x + w, y, t)

def wall_v(c, x, y, h, t=WALL):
    thick_wall(c, x, y, x, y + h, t)

def door_sym(c, x, y, size=22, angle=0, flip=False):
    """Door: line + quarter-circle arc."""
    c.saveState()
    c.translate(x, y)
    c.rotate(angle)
    if flip:
        c.transform(1, 0, 0, -1, 0, 0)
    c.setStrokeColor(C_WALL)
    c.setLineWidth(MED)
    c.line(0, 0, size, 0)
    c.setLineWidth(THIN)
    c.setDash(3, 3)
    c.arc(0, 0, size, size, 0, 90)
    c.setDash()
    c.restoreState()

def window_sym(c, x, y, w, angle=0):
    """Window: triple line in wall gap."""
    c.saveState()
    c.translate(x, y)
    c.rotate(angle)
    c.setStrokeColor(C_WALL)
    c.setLineWidth(BOLD)
    c.line(0, -WALL/2, w, -WALL/2)
    c.line(0,  WALL/2, w,  WALL/2)
    c.setLineWidth(THIN)
    c.line(0, -WALL/2, 0, WALL/2)
    c.line(w, -WALL/2, w, WALL/2)
    c.setLineWidth(MED)
    c.line(w * 0.33, -WALL/2, w * 0.33, WALL/2)
    c.line(w * 0.66, -WALL/2, w * 0.66, WALL/2)
    c.restoreState()

def dim_h(c, x1, x2, y, label, gap=14):
    """Horizontal dimension string."""
    c.setStrokeColor(C_DIM)
    c.setLineWidth(THIN)
    c.line(x1, y, x2, y)
    c.line(x1, y - 4, x1, y + 4)
    c.line(x2, y - 4, x2, y + 4)
    c.setFillColor(C_DIM)
    c.setFont("Helvetica", 7)
    c.drawCentredString((x1 + x2) / 2, y + 3, label)
    c.setFillColor(C_TEXT)

def dim_v(c, x, y1, y2, label):
    c.setStrokeColor(C_DIM)
    c.setLineWidth(THIN)
    c.line(x, y1, x, y2)
    c.line(x - 4, y1, x + 4, y1)
    c.line(x - 4, y2, x + 4, y2)
    c.saveState()
    c.translate(x - 10, (y1 + y2) / 2)
    c.rotate(90)
    c.setFillColor(C_DIM)
    c.setFont("Helvetica", 7)
    c.drawCentredString(0, 0, label)
    c.restoreState()
    c.setFillColor(C_TEXT)

def room_tag(c, x, y, name, sqft=None, small=False):
    fs = 7 if small else 9
    c.setFont("Helvetica-Bold", fs)
    c.setFillColor(C_TEXT)
    c.drawCentredString(x, y + (3 if sqft else 0), name)
    if sqft:
        c.setFont("Helvetica", fs - 1)
        c.drawCentredString(x, y - 7, f"{sqft} SF")

def elec_outlet(c, x, y, r=4):
    c.setStrokeColor(C_ELEC)
    c.setLineWidth(THIN)
    c.circle(x, y, r, stroke=1, fill=0)
    c.setFillColor(C_ELEC)
    c.circle(x, y, 1.2, stroke=0, fill=1)
    c.setFillColor(C_TEXT)

def elec_switch(c, x, y):
    c.setStrokeColor(C_ELEC)
    c.setFillColor(C_ELEC)
    c.setLineWidth(THIN)
    c.setFont("Helvetica-Bold", 7)
    c.drawString(x, y, "S")
    c.setFillColor(C_TEXT)

def elec_light(c, x, y, r=6):
    c.setStrokeColor(C_ELEC)
    c.setLineWidth(THIN)
    c.circle(x, y, r, stroke=1, fill=0)
    c.line(x - r, y, x + r, y)
    c.line(x, y - r, x, y + r)

def elec_panel(c, x, y, w=18, h=24):
    c.setStrokeColor(C_ELEC)
    c.setLineWidth(MED)
    c.rect(x, y, w, h, stroke=1, fill=0)
    c.setFont("Helvetica-Bold", 5)
    c.setFillColor(C_ELEC)
    c.drawCentredString(x + w / 2, y + h / 2, "EP")
    c.setFillColor(C_TEXT)

def plumb_toilet(c, x, y, angle=0):
    c.saveState()
    c.translate(x, y); c.rotate(angle)
    c.setStrokeColor(C_PLUMB); c.setLineWidth(THIN)
    c.ellipse(-8, -5, 8, 10, stroke=1, fill=0)
    c.rect(-5, -14, 10, 9, stroke=1, fill=0)
    c.restoreState()

def plumb_sink(c, x, y, w=14, h=12, angle=0):
    c.saveState()
    c.translate(x, y); c.rotate(angle)
    c.setStrokeColor(C_PLUMB); c.setLineWidth(THIN)
    c.roundRect(-w/2, -h/2, w, h, 3, stroke=1, fill=0)
    c.circle(0, 0, 2, stroke=1, fill=0)
    c.restoreState()

def plumb_tub(c, x, y, w=40, h=18, angle=0):
    c.saveState()
    c.translate(x, y); c.rotate(angle)
    c.setStrokeColor(C_PLUMB); c.setLineWidth(THIN)
    c.rect(-w/2, -h/2, w, h, stroke=1, fill=0)
    c.roundRect(-w/2 + 4, -h/2 + 3, w - 8, h - 6, 4, stroke=1, fill=0)
    c.restoreState()

def plumb_shower(c, x, y, s=20):
    c.setStrokeColor(C_PLUMB); c.setLineWidth(THIN)
    c.rect(x, y, s, s, stroke=1, fill=0)
    c.setDash(2, 3)
    c.arc(x, y, x + s, y + s, 180, -90)
    c.setDash()

def plumb_wh(c, x, y, r=8):
    c.setStrokeColor(C_PLUMB); c.setLineWidth(THIN)
    c.circle(x, y, r, stroke=1, fill=0)
    c.setFont("Helvetica", 5); c.setFillColor(C_PLUMB)
    c.drawCentredString(x, y - 2, "WH")
    c.setFillColor(C_TEXT)

def north_arrow(c, x, y, size=20):
    c.setStrokeColor(colors.black); c.setLineWidth(MED)
    c.line(x, y, x, y + size)
    c.setFillColor(colors.black)
    p = c.beginPath()
    p.moveTo(x, y + size)
    p.lineTo(x - 5, y + size - 10)
    p.lineTo(x + 5, y + size - 10)
    p.close()
    c.drawPath(p, fill=1)
    c.setFont("Helvetica-Bold", 9)
    c.drawCentredString(x, y + size + 4, "N")

def title_block(c, proj, sheet, drawn, scale, note="", rev="A"):
    # Border
    c.setStrokeColor(colors.black); c.setLineWidth(XBOLD)
    c.rect(10, 10, PW - 20, PH - 20)
    # Title bar at bottom
    c.setLineWidth(BOLD)
    c.line(10, 70, PW - 20, 70)
    c.line(10, 10, PW - 20, 70)
    # Columns
    c.line(PW - 230, 10, PW - 230, 70)
    c.line(PW - 140, 10, PW - 140, 70)
    c.line(PW - 70,  10, PW - 70,  70)

    c.setFont("Helvetica-Bold", 13)
    c.setFillColor(colors.black)
    c.drawString(16, 50, proj)
    c.setFont("Helvetica", 8)
    c.drawString(16, 37, f"Drawn by: {drawn}")
    c.drawString(16, 26, f"Date: 2025-03-17    Rev: {rev}")

    c.setFont("Helvetica-Bold", 9)
    c.drawString(PW - 226, 52, "SCALE")
    c.setFont("Helvetica", 9)
    c.drawString(PW - 226, 40, scale)

    c.setFont("Helvetica-Bold", 9)
    c.drawString(PW - 136, 52, "SHEET")
    c.setFont("Helvetica-Bold", 14)
    c.drawCentredString(PW - 105, 35, sheet)

    if note:
        c.setFont("Helvetica-Oblique", 7)
        c.setFillColor(C_NOTE)
        c.drawString(PW - 66, 52, "FIELD NOTE:")
        c.setFont("Helvetica", 6)
        # word-wrap note into 3 lines
        words = note.split()
        lines, cur = [], ""
        for w in words:
            if len(cur) + len(w) < 18:
                cur += (" " if cur else "") + w
            else:
                lines.append(cur); cur = w
        lines.append(cur)
        for i, ln in enumerate(lines[:4]):
            c.drawString(PW - 66, 42 - i * 8, ln)
        c.setFillColor(C_TEXT)

def column(c, x, y, s=8):
    c.setFillColor(C_HATCH); c.setStrokeColor(colors.black); c.setLineWidth(MED)
    c.rect(x - s/2, y - s/2, s, s, stroke=1, fill=1)
    # Center lines
    c.setStrokeColor(C_CENTER); c.setLineWidth(THIN); c.setDash(4, 3)
    c.line(x - 20, y, x + 20, y)
    c.line(x, y - 20, x, y + 20)
    c.setDash()

def section_mark(c, x, y, label):
    c.setStrokeColor(C_DIM); c.setLineWidth(THIN)
    c.circle(x, y, 8, stroke=1, fill=0)
    c.setFont("Helvetica-Bold", 6); c.setFillColor(C_DIM)
    c.drawCentredString(x, y - 2, label)
    c.setFillColor(C_TEXT)

def break_line(c, x1, y, x2):
    """Zigzag break line."""
    c.setStrokeColor(C_DIM); c.setLineWidth(THIN)
    mid = (x1 + x2) / 2
    p = c.beginPath()
    p.moveTo(x1, y)
    p.lineTo(mid - 10, y)
    p.lineTo(mid - 5, y + 6)
    p.lineTo(mid + 5, y - 6)
    p.lineTo(mid + 10, y)
    p.lineTo(x2, y)
    c.drawPath(p, stroke=1, fill=0)

def note_leader(c, x1, y1, x2, y2, text, fs=6.5):
    c.setStrokeColor(C_NOTE); c.setLineWidth(THIN)
    c.line(x1, y1, x2, y2)
    c.setFont("Helvetica-Oblique", fs); c.setFillColor(C_NOTE)
    c.drawString(x2 + 2, y2 - 3, text)
    c.setFillColor(C_TEXT)

def stair(c, x, y, w, h, steps):
    c.setStrokeColor(colors.black); c.setLineWidth(THIN)
    sw = w / steps
    for i in range(steps + 1):
        c.line(x + i * sw, y, x + i * sw, y + h)
    c.line(x, y, x + w, y)
    c.line(x, y + h, x + w, y + h)
    # Arrow
    c.setLineWidth(MED)
    mid = x + w / 2
    c.line(mid, y + 4, mid, y + h - 4)
    c.setFillColor(colors.black)
    p = c.beginPath()
    p.moveTo(mid, y + h - 4)
    p.lineTo(mid - 4, y + h - 12)
    p.lineTo(mid + 4, y + h - 12)
    p.close()
    c.drawPath(p, fill=1)
    c.setFont("Helvetica", 6); c.setFillColor(C_TEXT)
    c.drawCentredString(mid + 10, y + h / 2, "UP")


# ═══════════════════════════════════════════════════════════════
# BLUEPRINT 1 — 2,400 SF Single-Family Residence (First Floor)
# ═══════════════════════════════════════════════════════════════
def bp_house():
    path = f"{OUT}/01_SFR_FirstFloor_A1.pdf"
    c = canvas.Canvas(path, pagesize=landscape(letter))
    bg_grid(c)

    # ── Outer shell ──────────────────────────────────────────
    OX, OY, OW, OH = 80, 90, 540, 390

    # Foundation / outer walls (double-thick)
    for seg in [
        (OX,       OY,       OX + OW,  OY),        # south
        (OX,       OY + OH,  OX + OW,  OY + OH),    # north
        (OX,       OY,       OX,       OY + OH),    # west
        (OX + OW,  OY,       OX + OW,  OY + OH),    # east
        # Garage bump-out west
        (OX - 100, OY + 180, OX,       OY + 180),
        (OX - 100, OY + 390, OX,       OY + 390),
        (OX - 100, OY + 180, OX - 100, OY + 390),
    ]:
        thick_wall(c, *seg, t=8)

    # ── Interior walls ────────────────────────────────────────
    segs = [
        # Great room / kitchen divider
        (OX + 240, OY,      OX + 240, OY + 200),
        # Kitchen / laundry
        (OX + 360, OY,      OX + 360, OY + 140),
        # Laundry / hallway
        (OX + 360, OY + 140, OX + 480, OY + 140),
        # Master suite south wall
        (OX + 240, OY + 260, OX + 540, OY + 260),
        # Master bath / closet divider
        (OX + 380, OY + 260, OX + 380, OY + 390),
        # Master bath / bed divider
        (OX + 240, OY + 340, OX + 380, OY + 340),
        # Hall bath
        (OX + 80,  OY + 260, OX + 80,  OY + 390),
        (OX,       OY + 260, OX + 240, OY + 260),
        (OX + 80,  OY + 260, OX + 240, OY + 260),
        # Bed 2 / Bed 3 divider
        (OX + 160, OY + 260, OX + 160, OY + 390),
    ]
    for seg in segs:
        thick_wall(c, *seg)

    # ── Doors ─────────────────────────────────────────────────
    # Front entry
    door_sym(c, OX + 160, OY + 390, 28, 0)
    # Great room to master hall
    door_sym(c, OX + 240, OY + 280, 22, 270)
    # Master bed
    door_sym(c, OX + 260, OY + 260, 22, 90, flip=True)
    # Master bath
    door_sym(c, OX + 380, OY + 300, 18, 270)
    # Master closet
    door_sym(c, OX + 400, OY + 390, 18, 180)
    # Hall bath
    door_sym(c, OX + 100, OY + 260, 18, 90)
    # Bed 2
    door_sym(c, OX + 80,  OY + 300, 18, 0, flip=True)
    # Bed 3
    door_sym(c, OX + 180, OY + 300, 18, 0)
    # Kitchen exterior
    door_sym(c, OX + 460, OY, 22, 0)
    # Garage doors (double)
    c.setStrokeColor(colors.black); c.setLineWidth(BOLD)
    c.line(OX - 98, OY + 220, OX - 98, OY + 350)
    c.setLineWidth(THIN); c.setDash(4, 4)
    c.line(OX - 80, OY + 220, OX - 80, OY + 350)
    c.setDash()

    # ── Windows ───────────────────────────────────────────────
    # South facade
    window_sym(c, OX + 40,  OY, 50)
    window_sym(c, OX + 140, OY, 50)
    window_sym(c, OX + 280, OY, 60)
    window_sym(c, OX + 400, OY, 60)
    # North facade
    window_sym(c, OX + 20,  OY + 390, 40)
    window_sym(c, OX + 110, OY + 390, 40)
    window_sym(c, OX + 290, OY + 390, 50)
    window_sym(c, OX + 430, OY + 390, 50)
    # East facade
    window_sym(c, OX + 540, OY + 80,  40, 90)
    window_sym(c, OX + 540, OY + 220, 50, 90)

    # ── Electrical ────────────────────────────────────────────
    elec_panel(c, OX + 370, OY + 50)
    # Great room
    for pos in [(OX+60,OY+130),(OX+130,OY+130),(OX+180,OY+130),(OX+200,OY+220)]:
        elec_outlet(c, *pos)
    elec_light(c, OX + 120, OY + 160)
    elec_switch(c, OX + 88,  OY + 265)
    # Kitchen
    for pos in [(OX+270,OY+50),(OX+310,OY+50),(OX+350,OY+80),(OX+350,OY+120)]:
        elec_outlet(c, *pos)
    elec_light(c, OX + 300, OY + 100)
    # Master suite
    for pos in [(OX+300,OY+290),(OX+360,OY+290),(OX+310,OY+370),(OX+370,OY+370)]:
        elec_outlet(c, *pos)
    elec_light(c, OX + 320, OY + 330)
    elec_light(c, OX + 410, OY + 310)
    # Bedrooms
    elec_outlet(c, OX + 40,  OY + 320)
    elec_outlet(c, OX + 140, OY + 320)
    elec_light(c,  OX + 40,  OY + 350)
    elec_light(c,  OX + 120, OY + 350)
    elec_light(c,  OX + 195, OY + 350)
    # INTENTIONAL ERROR: bed 3 missing outlet on north wall
    elec_switch(c, OX + 168, OY + 265)

    # ── Plumbing ──────────────────────────────────────────────
    # Kitchen
    plumb_sink(c, OX + 290, OY + 30, 20, 14)
    # Laundry (washer/dryer boxes)
    c.setStrokeColor(C_PLUMB); c.setLineWidth(THIN)
    c.rect(OX + 365, OY + 10, 20, 20, stroke=1, fill=0)
    c.rect(OX + 390, OY + 10, 20, 20, stroke=1, fill=0)
    c.setFont("Helvetica", 5); c.setFillColor(C_PLUMB)
    c.drawCentredString(OX + 375, OY + 18, "W")
    c.drawCentredString(OX + 400, OY + 18, "D")
    c.setFillColor(C_TEXT)
    # Hall bath
    plumb_toilet(c, OX + 30, OY + 300)
    plumb_sink(c,   OX + 55, OY + 340)
    plumb_tub(c,    OX + 60, OY + 370, 45, 20)
    # Master bath
    plumb_toilet(c, OX + 410, OY + 280, 90)
    plumb_sink(c,   OX + 440, OY + 290, 18, 14)
    plumb_sink(c,   OX + 470, OY + 290, 18, 14)  # double vanity
    plumb_shower(c, OX + 415, OY + 340, 28)
    plumb_wh(c,     OX + 420, OY + 50)

    # ── Structural columns ───────────────────────────────────
    column(c, OX + 240, OY + 200)
    column(c, OX,       OY + 200)

    # ── Stairs ───────────────────────────────────────────────
    stair(c, OX + 200, OY + 200, 40, 60, 8)

    # ── Dimensions ───────────────────────────────────────────
    # Overall
    dim_h(c, OX, OX + OW,      OY - 30, "45'-0\"")
    dim_v(c, OX - 40, OY, OY + OH, "32'-6\"")
    # Room dims
    dim_h(c, OX, OX + 240,      OY - 18, "20'-0\"")
    dim_h(c, OX + 240, OX + 540, OY - 18, "25'-0\"")
    dim_v(c, OX + OW + 16, OY, OY + 260, "21'-8\"")
    dim_v(c, OX + OW + 16, OY + 260, OY + 390, "10'-10\"")
    # Garage
    dim_h(c, OX - 100, OX,      OY + 178, "8'-4\"")
    dim_v(c, OX - 116, OY + 180, OY + 390, "17'-6\"")

    # ── Room labels ──────────────────────────────────────────
    room_tag(c, OX + 120, OY + 130, "GREAT ROOM", 480)
    room_tag(c, OX + 300, OY + 100, "KITCHEN", 200)
    room_tag(c, OX + 420, OY + 80,  "LAUNDRY", 90)
    room_tag(c, OX + 320, OY + 310, "MASTER BED", 220, small=True)
    room_tag(c, OX + 430, OY + 310, "M. BATH",   120, small=True)
    room_tag(c, OX + 450, OY + 360, "WIC",        60, small=True)
    room_tag(c, OX + 40,  OY + 330, "BED 2",     130, small=True)
    room_tag(c, OX + 200, OY + 330, "BED 3",     120, small=True)
    room_tag(c, OX + 40,  OY + 290, "BATH 2",     60, small=True)
    room_tag(c, OX - 50,  OY + 285, "GARAGE",    400)

    # ── Section marks ─────────────────────────────────────────
    section_mark(c, OX + 240, OY + 200, "S1")
    section_mark(c, OX + 380, OY + 260, "S2")

    # ── Leaders / notes ───────────────────────────────────────
    note_leader(c, OX+370,OY+65, OX+430,OY+65, "200A PANEL")
    note_leader(c, OX+290,OY+30, OX+260,OY+15, "DBL. KITCHEN SINK")
    note_leader(c, OX+60, OY+370, OX+20, OY+360, "5' TUB — VERIFY CLEARANCE")
    note_leader(c, OX+195,OY+265,OX+215,OY+250, "INTENTIONAL: BED 3 N.WALL OUTLET MISSING")

    # ── North arrow + scale bar ──────────────────────────────
    north_arrow(c, PW - 55, PH - 90)
    # Scale bar
    c.setStrokeColor(colors.black); c.setLineWidth(MED)
    for i in range(5):
        x = PW - 160 + i * 20
        c.setFillColor(colors.black if i % 2 == 0 else colors.white)
        c.rect(x, PH - 56, 20, 8, stroke=1, fill=1)
    c.setFont("Helvetica", 6); c.setFillColor(C_TEXT)
    c.drawString(PW - 160, PH - 65, "0")
    c.drawString(PW - 120, PH - 65, "10'")
    c.drawString(PW - 80,  PH - 65, "20'")
    c.drawString(PW - 162, PH - 50, "SCALE BAR")

    title_block(c,
        "LANCELLOTTI RESIDENCE — 123 OAK STREET, HOUSTON TX",
        "A-1.0",
        "R. ARCHITECT",
        "1/4\" = 1'-0\"",
        note="Bed 3 north-wall outlet omitted. Tub clearance to verify on site.")
    c.save()
    print(f"Created: {path}")


# ═══════════════════════════════════════════════════════════════
# BLUEPRINT 2 — Full-Service Restaurant (2,800 SF)
# ═══════════════════════════════════════════════════════════════
def bp_restaurant():
    path = f"{OUT}/02_Restaurant_FloorPlan_A2.pdf"
    c = canvas.Canvas(path, pagesize=landscape(letter))
    bg_grid(c)

    OX, OY = 60, 85
    # Overall shell: 70' × 40'
    RW, RH = 560, 320

    for seg in [
        (OX,      OY,      OX+RW,  OY),
        (OX,      OY+RH,  OX+RW,  OY+RH),
        (OX,      OY,      OX,     OY+RH),
        (OX+RW,   OY,      OX+RW,  OY+RH),
    ]:
        thick_wall(c, *seg, t=8)

    # ── Interior walls ────────────────────────────────────────
    segs = [
        # Kitchen back-of-house wall
        (OX+350, OY,      OX+350, OY+220),
        # Walk-in cooler
        (OX+350, OY+160,  OX+560, OY+160),
        (OX+460, OY+160,  OX+460, OY+320),
        # Bar partition
        (OX+200, OY+220,  OX+350, OY+220),
        # Host stand partial
        (OX+100, OY+300,  OX+100, OY+320),
        # Restroom block
        (OX,     OY+220,  OX+140, OY+220),
        (OX+70,  OY+220,  OX+70,  OY+320),
        (OX+140, OY+220,  OX+140, OY+320),
        # Dry storage
        (OX+460, OY,      OX+460, OY+160),
        (OX+530, OY,      OX+530, OY+160),
    ]
    for seg in segs:
        thick_wall(c, *seg)

    # ── Booths (dining room) ──────────────────────────────────
    c.setStrokeColor(colors.Color(0.5, 0.35, 0.15)); c.setLineWidth(THIN)
    for row in range(4):
        for col in range(4):
            bx = OX + 155 + col * 50
            by = OY + 30  + row * 48
            c.rect(bx, by, 40, 14, stroke=1, fill=0)   # table
            c.rect(bx, by + 18, 40, 10, stroke=1, fill=0)  # bench back
            c.rect(bx, by - 12, 40, 10, stroke=1, fill=0)  # bench front

    # Bar stools
    c.setStrokeColor(C_PLUMB)
    for i in range(8):
        c.circle(OX + 205 + i * 18, OY + 235, 5, stroke=1, fill=0)
    # Bar counter
    c.setStrokeColor(colors.black); c.setLineWidth(BOLD)
    c.line(OX + 200, OY + 220, OX + 350, OY + 220)
    c.line(OX + 200, OY + 248, OX + 350, OY + 248)

    # ── Kitchen equipment ─────────────────────────────────────
    c.setStrokeColor(colors.Color(0.4, 0.4, 0.4)); c.setLineWidth(MED)
    # Range hood line
    c.setDash(3, 3)
    c.rect(OX + 360, OY + 140, 80, 16, stroke=1, fill=0)
    c.setDash()
    c.setFont("Helvetica", 5); c.setFillColor(colors.Color(0.4,0.4,0.4))
    c.drawCentredString(OX + 400, OY + 146, "EXHAUST HOOD")
    # Ranges
    for i in range(4):
        c.rect(OX + 357 + i * 20, OY + 80, 18, 18, stroke=1, fill=0)
        for ci in range(2):
            for ri in range(2):
                c.circle(OX + 362 + i*20 + ci*8, OY + 85 + ri*8, 3, stroke=1, fill=0)
    # Prep tables
    c.rect(OX + 356, OY + 30, 90, 18, stroke=1, fill=0)
    c.rect(OX + 356, OY + 52, 90, 18, stroke=1, fill=0)
    # Fryers
    c.rect(OX + 450, OY + 30, 18, 45, stroke=1, fill=0)
    c.rect(OX + 470, OY + 30, 18, 45, stroke=1, fill=0)
    c.setFillColor(C_TEXT)

    # Walk-in cooler hatching
    c.setStrokeColor(C_GRID); c.setLineWidth(0.4)
    for i in range(20):
        c.line(OX + 460, OY + 160 + i * 8, OX + 560, OY + 160 + i * 8)
    c.setFont("Helvetica-Bold", 8); c.setFillColor(C_PLUMB)
    c.drawCentredString(OX + 510, OY + 245, "WALK-IN")
    c.drawCentredString(OX + 510, OY + 233, "COOLER")
    c.setFillColor(C_TEXT)

    # ── Doors ─────────────────────────────────────────────────
    door_sym(c, OX + 100, OY + 320, 28, 270)   # main entry
    door_sym(c, OX + 350, OY + 80,  20, 180)   # kitchen pass
    door_sym(c, OX + 350, OY,       22, 0)      # back door
    door_sym(c, OX + 460, OY + 100, 18, 270)   # dry storage
    door_sym(c, OX + 20,  OY + 220, 18, 90)    # men's room
    door_sym(c, OX + 90,  OY + 220, 18, 90, flip=True)  # women's room
    # INTENTIONAL: kitchen walk-in cooler has no door symbol

    # ── Windows ───────────────────────────────────────────────
    window_sym(c, OX + 155, OY + 320, 50)
    window_sym(c, OX + 250, OY + 320, 50)
    window_sym(c, OX + 355, OY + 320, 50)
    window_sym(c, OX,       OY + 80,  50, 90)
    window_sym(c, OX,       OY + 180, 50, 90)

    # ── Electrical ────────────────────────────────────────────
    elec_panel(c, OX + 540, OY + 280)
    # Dining
    for pos in [(OX+170,OY+190),(OX+220,OY+190),(OX+270,OY+190),(OX+320,OY+190)]:
        elec_outlet(c, *pos)
    for pos in [(OX+170,OY+215),(OX+270,OY+215),(OX+320,OY+215)]:
        elec_light(c, *pos)
    # Kitchen — intentional sparse wiring
    elec_outlet(c, OX+380, OY+120)
    elec_outlet(c, OX+420, OY+120)
    elec_light(c,  OX+400, OY+60)
    # Missing exhaust fan circuit label (error)

    # ── Plumbing ──────────────────────────────────────────────
    # Men's room
    plumb_toilet(c, OX + 20, OY + 260)
    plumb_toilet(c, OX + 20, OY + 290)
    plumb_sink(c,   OX + 52, OY + 290)
    # Women's room
    plumb_toilet(c, OX + 90, OY + 260)
    plumb_toilet(c, OX + 90, OY + 290)
    plumb_sink(c,   OX + 122, OY + 290)
    # Kitchen
    plumb_sink(c, OX + 360, OY + 120, 24, 16)  # 3-compartment
    plumb_sink(c, OX + 390, OY + 120, 24, 16)
    plumb_sink(c, OX + 420, OY + 120, 24, 16)
    plumb_wh(c,   OX + 530, OY + 60)
    # Grease trap (intentional: label only, no spec)
    c.setFont("Helvetica-Bold", 6); c.setFillColor(C_NOTE)
    c.drawString(OX + 355, OY + 14, "GREASE TRAP — SIZE TBD")
    c.setFillColor(C_TEXT)

    # ── Dimensions ───────────────────────────────────────────
    dim_h(c, OX, OX + RW,      OY - 28, "70'-0\"")
    dim_v(c, OX - 35, OY, OY + RH, "40'-0\"")
    dim_h(c, OX, OX + 350,     OY - 16, "43'-9\"")
    dim_h(c, OX + 350, OX+560, OY - 16, "26'-3\"")
    dim_v(c, OX + RW + 16, OY, OY + 160, "20'-0\"")
    dim_v(c, OX + RW + 16, OY+160, OY+320, "20'-0\"")

    # ── Room tags ─────────────────────────────────────────────
    room_tag(c, OX + 260, OY + 140, "DINING ROOM", 1400)
    room_tag(c, OX + 275, OY + 232, "BAR / LOUNGE", 320)
    room_tag(c, OX + 410, OY + 100, "KITCHEN", 700)
    room_tag(c, OX + 495, OY + 240, "WALK-IN", 100, small=True)
    room_tag(c, OX + 35,  OY + 270, "M", 60, small=True)
    room_tag(c, OX + 105, OY + 270, "W", 60, small=True)
    room_tag(c, OX + 495, OY + 80,  "DRY\nSTORAGE", 70, small=True)

    # ── Notes ─────────────────────────────────────────────────
    note_leader(c, OX+510,OY+290, PW-80,OY+290, "400A MAIN PANEL")
    note_leader(c, OX+400,OY+158, OX+380,OY+178, "HOOD — NO CIRCUIT LABELED (ERR)")
    note_leader(c, OX+460,OY+200, OX+440,OY+215, "WALK-IN: NO DOOR DRAWN")
    note_leader(c, OX+530,OY+68,  OX+550,OY+55,  "50-GAL GAS WH")

    north_arrow(c, PW - 50, PH - 90)
    title_block(c,
        "THE GRILLHOUSE RESTAURANT — 456 MAIN ST, CHARLOTTE NC",
        "A-2.0",
        "R. ARCHITECT",
        "1/8\" = 1'-0\"",
        note="Walk-in cooler door omitted. Exhaust circuit unlabeled. Grease trap size TBD.")
    c.save()
    print(f"Created: {path}")


# ═══════════════════════════════════════════════════════════════
# BLUEPRINT 3 — Medical Office / Clinic (3,200 SF)
# ═══════════════════════════════════════════════════════════════
def bp_medical():
    path = f"{OUT}/03_MedicalOffice_FloorPlan_A3.pdf"
    c = canvas.Canvas(path, pagesize=landscape(letter))
    bg_grid(c)

    OX, OY = 55, 80
    MW, MH = 580, 380

    # Outer shell
    for seg in [
        (OX,     OY,     OX+MW, OY),
        (OX,     OY+MH, OX+MW, OY+MH),
        (OX,     OY,     OX,    OY+MH),
        (OX+MW,  OY,    OX+MW,  OY+MH),
    ]:
        thick_wall(c, *seg, t=8)

    # ── Interior partitions ───────────────────────────────────
    segs = [
        # Reception / waiting divider
        (OX+160, OY+MH,   OX+160, OY+280),
        (OX,     OY+280,  OX+160, OY+280),
        # Corridor spine
        (OX+160, OY+200,  OX+MW,  OY+200),
        # Exam rooms (south corridor, 5 rooms)
        (OX+160, OY,      OX+160, OY+200),
        (OX+260, OY,      OX+260, OY+200),
        (OX+340, OY,      OX+340, OY+200),
        (OX+420, OY,      OX+420, OY+200),
        (OX+500, OY,      OX+500, OY+200),
        # North rooms
        (OX+260, OY+200,  OX+260, OY+MH),
        (OX+380, OY+200,  OX+380, OY+MH),
        (OX+460, OY+200,  OX+460, OY+MH),
        # Lab / X-ray
        (OX+460, OY+280,  OX+MW,  OY+280),
        # Break room
        (OX+380, OY+280,  OX+460, OY+280),
    ]
    for seg in segs:
        thick_wall(c, *seg)

    # ── Doors ─────────────────────────────────────────────────
    door_sym(c, OX + 60, OY + MH, 28, 270)   # main entry
    door_sym(c, OX + 162, OY + MH - 40, 20, 0)   # reception
    # Exam room doors
    for i, x in enumerate([OX+165, OX+265, OX+345, OX+425]):
        door_sym(c, x, OY + 180, 18, 90, flip=(i%2==0))
    door_sym(c, OX + 502, OY + 180, 18, 90)
    # North rooms
    door_sym(c, OX + 162, OY + 220, 18, 180)
    door_sym(c, OX + 265, OY + 215, 18, 180)
    door_sym(c, OX + 385, OY + 215, 18, 180)
    door_sym(c, OX + 465, OY + 215, 18, 180)
    # X-ray — lead-lined door (special)
    c.setStrokeColor(C_NOTE); c.setLineWidth(BOLD)
    c.line(OX + MW, OY + 250, OX + MW - 26, OY + 250)
    c.setStrokeColor(colors.black)
    # INTENTIONAL: break room has no door

    # ── Windows ───────────────────────────────────────────────
    window_sym(c, OX + 40,  OY + MH, 60)
    window_sym(c, OX + 200, OY + MH, 40)
    window_sym(c, OX,       OY + 80,  40, 90)
    window_sym(c, OX,       OY + 200, 50, 90)
    window_sym(c, OX,       OY + 320, 40, 90)
    window_sym(c, OX + 300, OY,       50)
    window_sym(c, OX + 440, OY,       50)
    # X-ray room — NO WINDOW (radiation shielding — intentional annotation)
    note_leader(c, OX+MW-50, OY+250, OX+MW+5, OY+265, "LEAD-LINED — NO WINDOW")

    # ── Electrical ────────────────────────────────────────────
    elec_panel(c, OX + 155, OY + 100)
    # Exam rooms
    for i, cx in enumerate([OX+210, OX+300, OX+380, OX+460]):
        elec_outlet(c, cx, OY + 100)
        elec_outlet(c, cx, OY + 140)
        elec_light(c,  cx, OY + 160)
    # Corridor lights
    for cx in range(OX+180, OX+MW-20, 60):
        elec_light(c, cx, OY + 200)
    # Waiting / reception
    for pos in [(OX+60,OY+350),(OX+110,OY+350),(OX+60,OY+420),(OX+110,OY+420)]:
        elec_outlet(c, *pos)
    elec_light(c, OX + 85, OY + 390)
    # X-ray room — INTENTIONAL: no electrical shown (error)
    note_leader(c, OX+MW-30, OY+235, OX+MW+5, OY+230, "X-RAY ELEC. MISSING (ERR)")

    # ── Plumbing ──────────────────────────────────────────────
    # Each exam room sink
    for cx in [OX+210, OX+300, OX+380, OX+460, OX+540]:
        plumb_sink(c, cx, OY + 20, 14, 10)
    # Staff restrooms (corridor)
    plumb_toilet(c, OX + 175, OY + 240)
    plumb_sink(c,   OX + 200, OY + 240)
    plumb_toilet(c, OX + 175, OY + 270, 90)
    plumb_sink(c,   OX + 200, OY + 270)
    # Break room
    plumb_sink(c, OX + 410, OY + 300, 16, 12)
    # INTENTIONAL: No eyewash station shown in lab
    c.setFont("Helvetica-Bold", 6); c.setFillColor(C_NOTE)
    c.drawString(OX + MW - 100, OY + 298, "EYEWASH REQ'D — NOT SHOWN")
    c.setFillColor(C_TEXT)

    # ── Dimensions ───────────────────────────────────────────
    dim_h(c, OX, OX + MW,     OY - 30, "72'-6\"")
    dim_v(c, OX - 35, OY, OY+MH, "47'-6\"")
    dim_h(c, OX, OX + 160,    OY - 18, "20'-0\"")
    dim_h(c, OX+160, OX+MW,   OY - 18, "52'-6\"")
    dim_v(c, OX+MW+18, OY, OY+200, "25'-0\"")
    dim_v(c, OX+MW+18, OY+200, OY+MH, "22'-6\"")

    # ── Room labels ──────────────────────────────────────────
    room_tag(c, OX + 80,  OY + 350, "WAITING", 280)
    room_tag(c, OX + 80,  OY + 290, "RECEPTION", 140, small=True)
    room_tag(c, OX + 210, OY + 100, "EXAM 1",   150, small=True)
    room_tag(c, OX + 300, OY + 100, "EXAM 2",   150, small=True)
    room_tag(c, OX + 380, OY + 100, "EXAM 3",   150, small=True)
    room_tag(c, OX + 460, OY + 100, "EXAM 4",   150, small=True)
    room_tag(c, OX + 540, OY + 100, "EXAM 5",   150, small=True)
    room_tag(c, OX + 210, OY + 300, "CONSULT",  200, small=True)
    room_tag(c, OX + 320, OY + 300, "OFFICE",   180, small=True)
    room_tag(c, OX + 420, OY + 300, "BREAK",    120, small=True)
    room_tag(c, OX + MW - 60, OY + 330, "X-RAY /\nLAB", 220, small=True)

    # Corridor label
    c.setFont("Helvetica-Oblique", 7); c.setFillColor(colors.Color(0.4,0.4,0.4))
    c.drawCentredString(OX + 380, OY + 192, "— CORRIDOR —")
    c.setFillColor(C_TEXT)

    north_arrow(c, PW - 50, PH - 90)
    title_block(c,
        "COASTAL MEDICAL CLINIC — 789 HEALTH BLVD, WILMINGTON NC",
        "A-3.0",
        "R. ARCHITECT",
        "1/8\" = 1'-0\"",
        note="Break room door omitted. X-ray elec. missing. Eyewash not shown in lab.")
    c.save()
    print(f"Created: {path}")


# ═══════════════════════════════════════════════════════════════
# BLUEPRINT 4 — Warehouse / Industrial (8,000 SF) with Mezzanine
# ═══════════════════════════════════════════════════════════════
def bp_warehouse():
    path = f"{OUT}/04_Warehouse_Industrial_A4.pdf"
    c = canvas.Canvas(path, pagesize=landscape(letter))
    bg_grid(c)

    OX, OY = 50, 75
    WW, WH = 600, 420

    # Outer shell (tilt-up concrete — extra thick)
    for seg in [
        (OX,    OY,    OX+WW, OY),
        (OX,    OY+WH, OX+WW, OY+WH),
        (OX,    OY,    OX,    OY+WH),
        (OX+WW, OY,   OX+WW, OY+WH),
    ]:
        thick_wall(c, *seg, t=12)

    # ── Structural steel columns (bay grid 20' × 20') ─────────
    col_xs = [OX + x for x in range(0, WW + 1, 120)]
    col_ys = [OY + y for y in range(0, WH + 1, 140)]
    for cx in col_xs[1:-1]:
        for cy in col_ys[1:-1]:
            column(c, cx, cy, 10)

    # Column grid labels
    c.setFont("Helvetica", 7); c.setFillColor(C_DIM)
    for i, cx in enumerate(col_xs):
        c.drawCentredString(cx, OY + WH + 14, chr(65 + i))
    for i, cy in enumerate(col_ys):
        c.drawRightString(OX - 8, cy - 2, str(i + 1))
    c.setFillColor(C_TEXT)

    # ── Interior partitions ───────────────────────────────────
    segs = [
        # Office block (north-west)
        (OX,     OY+280, OX+200, OY+280),
        (OX+200, OY+280, OX+200, OY+WH),
        # Mezzanine outline (dashed)
    ]
    for seg in segs:
        thick_wall(c, *seg)

    # Mezzanine (dashed green)
    c.setStrokeColor(C_NEW); c.setLineWidth(BOLD); c.setDash(10, 5)
    c.rect(OX + 200, OY + 280, 200, 140, stroke=1, fill=0)
    c.setDash()
    c.setFont("Helvetica-Bold", 9); c.setFillColor(C_NEW)
    c.drawCentredString(OX + 300, OY + 355, "MEZZANINE")
    c.drawCentredString(OX + 300, OY + 342, "(ABOVE)")
    c.setFillColor(C_TEXT)

    # Office sub-rooms
    sub = [
        (OX,     OY+350, OX+100, OY+350),
        (OX+100, OY+280, OX+100, OY+WH),
        (OX,     OY+400, OX+100, OY+400),
        (OX+100, OY+350, OX+200, OY+350),
    ]
    for seg in sub:
        thick_wall(c, *seg)

    # ── Loading docks (south wall) ─────────────────────────────
    c.setStrokeColor(colors.black); c.setLineWidth(BOLD)
    dock_xs = [OX + 60, OX + 180, OX + 300, OX + 420, OX + 540]
    for dx in dock_xs:
        # Dock leveler pit
        c.setFillColor(colors.Color(0.85, 0.85, 0.85))
        c.rect(dx - 20, OY - 20, 40, 20, stroke=1, fill=1)
        c.setFillColor(C_TEXT)
        c.setFont("Helvetica", 5); c.setFillColor(C_DIM)
        c.drawCentredString(dx, OY - 12, "DOCK\nLEVELER")
        c.setFillColor(C_TEXT)
        # Overhead door symbol
        c.setStrokeColor(colors.black); c.setLineWidth(THIN); c.setDash(5, 3)
        c.line(dx - 20, OY, dx + 20, OY)
        c.setDash()

    # Drive apron label
    c.setFont("Helvetica-Oblique", 8); c.setFillColor(colors.Color(0.4,0.4,0.4))
    c.drawCentredString(OX + 300, OY - 35, "TRUCK COURT / CONCRETE APRON")
    c.setFillColor(C_TEXT)

    # ── Doors ─────────────────────────────────────────────────
    door_sym(c, OX, OY + 320, 28, 90)      # office entry
    door_sym(c, OX + 102, OY + 365, 18, 0)
    door_sym(c, OX + 102, OY + 415, 18, 0, flip=True)
    door_sym(c, OX + 200, OY + 295, 22, 0) # warehouse entry from office
    # Man door east side
    door_sym(c, OX + WW, OY + 200, 24, 270, flip=True)
    # INTENTIONAL: no door from office to mezzanine stair

    # ── Windows (office only) ────────────────────────────────
    for wx in [OX + 30, OX + 100, OX + 150]:
        window_sym(c, wx, OY + WH, 40)
    window_sym(c, OX, OY + 310, 40, 90)
    window_sym(c, OX, OY + 390, 40, 90)

    # ── Electrical ────────────────────────────────────────────
    elec_panel(c, OX + 210, OY + 390)
    # High-bay lights (warehouse grid)
    c.setStrokeColor(C_ELEC); c.setLineWidth(THIN)
    for lx in [OX+100, OX+220, OX+340, OX+460, OX+560]:
        for ly in [OY+60, OY+160, OY+240]:
            elec_light(c, lx, ly, 9)
    # Office outlets
    for pos in [(OX+30,OY+310),(OX+60,OY+310),(OX+30,OY+370),(OX+60,OY+370)]:
        elec_outlet(c, *pos)
    elec_light(c, OX+50,  OY+420)
    elec_light(c, OX+150, OY+420)
    elec_light(c, OX+150, OY+315)
    # Dock lights
    for dx in dock_xs:
        elec_outlet(c, dx, OY + 30)
    # INTENTIONAL: mezzanine has no electrical
    note_leader(c, OX+300, OY+350, OX+420, OY+380, "MEZZ ELEC. NOT SHOWN — TBD")

    # ── Plumbing ──────────────────────────────────────────────
    plumb_toilet(c, OX + 20, OY + 360)
    plumb_toilet(c, OX + 45, OY + 360)
    plumb_sink(c,   OX + 70, OY + 365)
    plumb_toilet(c, OX + 20, OY + 405)
    plumb_sink(c,   OX + 50, OY + 415)
    plumb_wh(c,     OX + 160, OY + 295)
    # Floor drains in warehouse
    for pos in [(OX+200,OY+60),(OX+400,OY+60),(OX+400,OY+200),(OX+200,OY+200)]:
        c.setStrokeColor(C_PLUMB); c.setLineWidth(THIN)
        c.circle(*pos, 5, stroke=1, fill=0)
        c.setFont("Helvetica", 5); c.setFillColor(C_PLUMB)
        c.drawCentredString(pos[0], pos[1] - 9, "FD")
        c.setFillColor(C_TEXT)
    # INTENTIONAL: only 1 restroom shown for 8000 SF (code requires 2 sets)
    note_leader(c, OX+50,OY+380, OX-5,OY+360, "ONLY 1 RR SHOWN — CODE REQ'S 2")

    # ── Stairs to mezzanine ───────────────────────────────────
    stair(c, OX + 200, OY + 280, 36, 50, 7)

    # ── Dimensions ───────────────────────────────────────────
    dim_h(c, OX, OX + WW,      OY - 44, "75'-0\"")
    dim_v(c, OX - 40, OY, OY + WH, "52'-6\"")
    dim_h(c, OX, OX + 200,     OY - 30, "25'-0\"")
    dim_h(c, OX+200, OX+WW,    OY - 30, "50'-0\"")
    dim_v(c, OX+WW+18, OY, OY+280, "35'-0\"")
    dim_v(c, OX+WW+18, OY+280, OY+WH, "17'-6\"")
    # Bay spacing
    for i in range(len(col_xs) - 1):
        dim_h(c, col_xs[i], col_xs[i+1], OY + WH + 26, "20'-0\"")

    # ── Room labels ──────────────────────────────────────────
    room_tag(c, OX + 350, OY + 190, "WAREHOUSE / STORAGE", 6000)
    room_tag(c, OX + 50,  OY + 440, "OPEN OFFICE",  800, small=True)
    room_tag(c, OX + 150, OY + 440, "CONF. ROOM",   200, small=True)
    room_tag(c, OX + 50,  OY + 375, "RESTROOMS",     80, small=True)
    room_tag(c, OX + 50,  OY + 310, "MGMT OFFICE",  180, small=True)

    # Break line (showing partial plan)
    break_line(c, OX + 240, OY + 130, OX + 360)

    north_arrow(c, PW - 50, PH - 90)
    title_block(c,
        "BUILDAI DISTRIBUTION WAREHOUSE — 1000 INDUSTRIAL PKWY, DALLAS TX",
        "A-4.0",
        "R. ARCHITECT",
        "1/16\" = 1'-0\"",
        note="Only 1 restroom set. Mezzanine electrical TBD. No door to mezzanine from office.",
        rev="B")
    c.save()
    print(f"Created: {path}")


if __name__ == "__main__":
    bp_house()
    bp_restaurant()
    bp_medical()
    bp_warehouse()
    print(f"\nAll 4 blueprints saved to: {OUT}")
    print("\nIntentional errors per sheet:")
    print("  A-1.0 Residence  — Bed 3 outlet missing, tub clearance unverified")
    print("  A-2.0 Restaurant — Walk-in cooler door missing, exhaust circuit unlabeled, grease trap TBD")
    print("  A-3.0 Medical    — Break room no door, X-ray electrical missing, eyewash not shown")
    print("  A-4.0 Warehouse  — Only 1 restroom (code violation), mezzanine electrical TBD, stair has no door")
