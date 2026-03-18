"""
Generate mock blueprint PDFs for testing BuildAI.
Each blueprint has intentional quirks to test the AI analysis pipeline.
"""
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
import os

OUT = os.path.expanduser("~/Desktop/test_blueprints")
os.makedirs(OUT, exist_ok=True)

W, H = letter  # 612 x 792


def grid(c, step=20):
    """Light grid background."""
    c.setStrokeColor(colors.Color(0.9, 0.9, 0.95))
    c.setLineWidth(0.3)
    for x in range(0, int(W), step):
        c.line(x, 0, x, H)
    for y in range(0, int(H), step):
        c.line(0, y, W, y)


def title_block(c, title, scale, note=""):
    c.setStrokeColor(colors.black)
    c.setLineWidth(1)
    c.rect(20, 20, W - 40, 60)
    c.setFont("Helvetica-Bold", 14)
    c.setFillColor(colors.black)
    c.drawString(30, 60, title)
    c.setFont("Helvetica", 10)
    c.drawString(30, 44, f"Scale: {scale}    Date: 2025-03-17")
    if note:
        c.setFillColor(colors.red)
        c.drawString(30, 30, f"NOTE: {note}")
        c.setFillColor(colors.black)


def room_label(c, x, y, name, sqft=None):
    c.setFont("Helvetica-Bold", 9)
    c.setFillColor(colors.black)
    c.drawCentredString(x, y + 4, name)
    if sqft:
        c.setFont("Helvetica", 8)
        c.drawCentredString(x, y - 8, f"{sqft} sq ft")


def dim_line(c, x1, y1, x2, y2, label, offset=12):
    """Draw a dimension line with label."""
    c.setStrokeColor(colors.Color(0.3, 0.3, 0.7))
    c.setLineWidth(0.6)
    c.line(x1, y1 - offset, x2, y2 - offset)
    c.line(x1, y1, x1, y1 - offset - 4)
    c.line(x2, y2, x2, y2 - offset - 4)
    c.setFont("Helvetica", 7)
    c.setFillColor(colors.Color(0.3, 0.3, 0.7))
    c.drawCentredString((x1 + x2) / 2, y1 - offset - 12, label)
    c.setFillColor(colors.black)


def door(c, x, y, w=20, swing_right=True):
    """Draw a door symbol."""
    c.setStrokeColor(colors.black)
    c.setLineWidth(1)
    c.line(x, y, x + w, y)
    import math
    if swing_right:
        c.arc(x, y - w, x + w * 2, y + w, 90, -90)
    else:
        c.arc(x - w, y - w, x + w, y + w, 0, 90)


def window(c, x, y, w=30):
    """Draw a window symbol (3 lines)."""
    c.setStrokeColor(colors.black)
    c.setLineWidth(1)
    c.line(x, y, x + w, y)
    c.setLineWidth(0.5)
    c.line(x + w * 0.33, y, x + w * 0.33, y + 6)
    c.line(x + w * 0.66, y, x + w * 0.66, y + 6)


def elec_outlet(c, x, y):
    c.setStrokeColor(colors.Color(0.8, 0.5, 0))
    c.setLineWidth(0.8)
    c.circle(x, y, 4, stroke=1, fill=0)
    c.line(x - 2, y, x + 2, y)
    c.line(x, y - 2, x, y + 2)


def plumbing_fixture(c, x, y, label):
    c.setStrokeColor(colors.Color(0, 0.4, 0.8))
    c.setLineWidth(0.8)
    c.rect(x - 8, y - 5, 16, 10, stroke=1, fill=0)
    c.setFont("Helvetica", 6)
    c.setFillColor(colors.Color(0, 0.4, 0.8))
    c.drawCentredString(x, y - 1, label)
    c.setFillColor(colors.black)


# ─────────────────────────────────────────────
# Blueprint 1: Simple 3-bed / 2-bath house
# ─────────────────────────────────────────────
def bp1():
    path = f"{OUT}/01_residential_3bed_simple.pdf"
    c = canvas.Canvas(path, pagesize=letter)
    grid(c)

    c.setStrokeColor(colors.black)
    c.setLineWidth(2)

    # Outer walls
    c.rect(60, 100, 480, 620)

    # Interior walls
    c.setLineWidth(1.5)
    # Vertical center wall
    c.line(300, 100, 300, 720)
    # Horizontal divider (upper/lower)
    c.line(60, 420, 540, 420)
    # Bedroom divider
    c.line(300, 420, 300, 720)
    c.line(420, 420, 420, 720)

    # Room labels
    room_label(c, 180, 580, "Master Bedroom", 180)
    room_label(c, 360, 580, "Bedroom 2", 130)
    room_label(c, 480, 580, "Bedroom 3", 120)
    room_label(c, 180, 280, "Living Room", 240)
    room_label(c, 420, 280, "Kitchen", 160)
    room_label(c, 420, 160, "Bathroom", 80)  # intentional: missing sqft annotation

    # Doors
    door(c, 270, 420, 20)
    door(c, 390, 420, 20)
    door(c, 150, 420, 20)

    # Windows
    window(c, 80, 600, 40)
    window(c, 310, 600, 40)
    window(c, 430, 600, 40)
    window(c, 80, 280, 40)
    window(c, 450, 380, 40)

    # Electrical
    for pos in [(120, 500), (240, 500), (340, 500), (460, 500), (150, 200), (400, 200)]:
        elec_outlet(c, *pos)

    # Plumbing
    plumbing_fixture(c, 420, 150, "TLT")
    plumbing_fixture(c, 460, 150, "SNK")

    # Dimension lines
    dim_line(c, 60, 720, 540, 720, "40'-0\"")
    dim_line(c, 60, 100, 60, 720, "51'-8\"")  # intentional wrong dimension

    title_block(c, "Residential Floor Plan — 3 Bed / 2 Bath", "1/4\" = 1'-0\"",
                note="Bathroom missing sqft — dimension on north wall approximate")
    c.save()
    print(f"Created: {path}")


# ─────────────────────────────────────────────
# Blueprint 2: Open-plan commercial office
# ─────────────────────────────────────────────
def bp2():
    path = f"{OUT}/02_commercial_office_openplan.pdf"
    c = canvas.Canvas(path, pagesize=letter)
    grid(c)

    c.setStrokeColor(colors.black)
    c.setLineWidth(2)
    c.rect(50, 100, 500, 580)

    # Conference room
    c.setLineWidth(1.5)
    c.rect(50, 520, 180, 160)
    room_label(c, 140, 600, "Conference Room", 288)

    # Server room (intentional: no door symbol)
    c.rect(370, 540, 180, 140)
    room_label(c, 460, 610, "Server Room", 252)

    # Bathrooms
    c.rect(50, 100, 100, 120)
    c.rect(150, 100, 100, 120)
    room_label(c, 100, 160, "Men's", 120)
    room_label(c, 200, 160, "Women's", 120)

    # Open office area label
    room_label(c, 310, 380, "Open Office", 1800)

    # Workstation grid (desks)
    c.setStrokeColor(colors.Color(0.6, 0.6, 0.6))
    c.setLineWidth(0.5)
    for row in range(6):
        for col in range(5):
            x = 120 + col * 80
            y = 240 + row * 50
            c.rect(x, y, 60, 30)

    # Electrical — intentional: cluster in one corner only (missing outlets elsewhere)
    c.setStrokeColor(colors.black)
    for pos in [(80, 500), (100, 500), (120, 500)]:
        elec_outlet(c, *pos)

    # Plumbing
    plumbing_fixture(c, 80, 140, "TLT")
    plumbing_fixture(c, 180, 140, "TLT")
    plumbing_fixture(c, 100, 120, "SNK")
    plumbing_fixture(c, 200, 120, "SNK")

    # Windows
    for x in [80, 160, 250, 340, 430]:
        window(c, x, 676, 50)

    # Doors
    door(c, 220, 100, 24)
    door(c, 100, 520, 20)

    dim_line(c, 50, 680, 550, 680, "41'-8\"")
    dim_line(c, 34, 100, 34, 680, "48'-4\"")

    title_block(c, "Commercial Office — Open Plan", "1/8\" = 1'-0\"",
                note="Server room has no door symbol — electrical outlets incomplete")
    c.save()
    print(f"Created: {path}")


# ─────────────────────────────────────────────
# Blueprint 3: Residential addition / renovation
# ─────────────────────────────────────────────
def bp3():
    path = f"{OUT}/03_residential_addition_reno.pdf"
    c = canvas.Canvas(path, pagesize=letter)
    grid(c)

    # Existing structure (solid)
    c.setStrokeColor(colors.black)
    c.setLineWidth(2)
    c.rect(60, 200, 350, 460)

    # New addition (dashed)
    c.setDash(8, 4)
    c.setLineWidth(2)
    c.setStrokeColor(colors.Color(0.2, 0.5, 0.2))
    c.rect(410, 300, 140, 200)
    c.setDash()
    c.setStrokeColor(colors.black)

    # Legend
    c.setLineWidth(1.5)
    c.line(380, 750, 420, 750)
    c.setFont("Helvetica", 8)
    c.drawString(425, 747, "Existing")
    c.setDash(8, 4)
    c.setStrokeColor(colors.Color(0.2, 0.5, 0.2))
    c.line(380, 735, 420, 735)
    c.setDash()
    c.setStrokeColor(colors.black)
    c.drawString(425, 732, "New Addition")

    # Interior walls (existing)
    c.setLineWidth(1.2)
    c.line(60, 500, 410, 500)
    c.line(240, 500, 240, 660)
    c.line(240, 200, 240, 400)

    # Rooms
    room_label(c, 150, 590, "Living Room", 320)
    room_label(c, 330, 590, "Master Bed", 200)
    room_label(c, 150, 380, "Kitchen", 180)
    room_label(c, 330, 300, "Bathroom", 90)
    room_label(c, 480, 400, "New\nFamily Room", 280)

    # Intentional error: overlapping wall line
    c.setStrokeColor(colors.red)
    c.setLineWidth(0.8)
    c.line(238, 390, 245, 410)  # misaligned wall junction
    c.setStrokeColor(colors.black)

    # Doors & windows
    door(c, 210, 500, 20)
    door(c, 60, 380, 20)
    window(c, 80, 620, 40)
    window(c, 300, 660, 40)
    window(c, 410, 400, 0)  # intentional: zero-width window (error)

    # Electrical
    for pos in [(120, 560), (300, 560), (150, 320)]:
        elec_outlet(c, *pos)

    # Plumbing
    plumbing_fixture(c, 330, 260, "TLT")
    plumbing_fixture(c, 360, 260, "SNK")
    plumbing_fixture(c, 150, 240, "SNK")

    dim_line(c, 60, 196, 410, 196, "29'-2\"")
    dim_line(c, 34, 200, 34, 660, "38'-4\"")

    title_block(c, "Residential Renovation + Addition", "1/4\" = 1'-0\"",
                note="Wall junction misaligned at kitchen/bath — verify addition connection point")
    c.save()
    print(f"Created: {path}")


# ─────────────────────────────────────────────
# Blueprint 4: Small retail space
# ─────────────────────────────────────────────
def bp4():
    path = f"{OUT}/04_retail_storefront.pdf"
    c = canvas.Canvas(path, pagesize=letter)
    grid(c)

    c.setStrokeColor(colors.black)
    c.setLineWidth(2)
    c.rect(60, 150, 480, 500)

    # Interior partitions
    c.setLineWidth(1.5)
    c.line(60, 400, 540, 400)   # back wall
    c.line(440, 400, 440, 650)  # stockroom divider
    c.line(60, 300, 200, 300)   # office partial
    c.line(200, 150, 200, 300)

    # Room labels
    room_label(c, 260, 570, "Retail Floor", 1200)
    room_label(c, 490, 540, "Stock\nRoom", 200)
    room_label(c, 125, 240, "Office", 150)
    room_label(c, 370, 260, "Storage", 300)

    # Storefront windows (large)
    c.setStrokeColor(colors.Color(0.5, 0.7, 1.0))
    c.setLineWidth(3)
    c.line(100, 650, 200, 650)
    c.line(220, 650, 340, 650)
    c.line(360, 650, 480, 650)
    c.setStrokeColor(colors.black)

    # Entry doors (double)
    c.setLineWidth(1.5)
    door(c, 250, 650, 20)
    door(c, 270, 650, 20, swing_right=False)

    # Back door
    door(c, 420, 400, 20)

    # Office door (intentional: missing)
    # door(c, 180, 300, 20)  # commented out — no door to office

    # Electrical — retail needs many outlets, but only a few drawn (intentional gap)
    for pos in [(100, 380), (200, 380), (300, 380), (400, 380)]:
        elec_outlet(c, *pos)
    # Missing outlets on retail floor (intentional error)

    # Plumbing (intentional: no bathroom shown — code violation flag)
    # No plumbing fixtures — should trigger compliance warning

    # Dimensions
    dim_line(c, 60, 646, 540, 646, "40'-0\"")
    dim_line(c, 40, 150, 40, 650, "41'-8\"")

    # Scale bar
    c.setStrokeColor(colors.black)
    c.setLineWidth(1)
    c.rect(380, 130, 100, 10)
    c.rect(430, 130, 50, 10)
    c.setFillColor(colors.black)
    c.rect(430, 130, 50, 10)
    c.setFillColor(colors.white)
    c.setFont("Helvetica", 7)
    c.setFillColor(colors.black)
    c.drawString(378, 120, "0")
    c.drawString(425, 120, "10'")
    c.drawString(478, 120, "20'")

    title_block(c, "Retail Storefront — Ground Floor", "1/8\" = 1'-0\"",
                note="No bathroom shown — ADA compliance issue. Office has no door. Outlets incomplete.")
    c.save()
    print(f"Created: {path}")


if __name__ == "__main__":
    bp1()
    bp2()
    bp3()
    bp4()
    print(f"\nAll blueprints saved to: {OUT}")
    print("\nIntentional errors per blueprint:")
    print("  01 — Missing bathroom sqft, wrong north wall dimension")
    print("  02 — Server room has no door, electrical outlets only in one corner")
    print("  03 — Misaligned wall junction, zero-width window on addition")
    print("  04 — No bathroom (ADA violation), no office door, incomplete outlets")
