from __future__ import annotations
"""
interactive_dashboard.py — AXIS PERFORMANCE Module 11
======================================================
Launches a professional 5-tab Dash web dashboard.

Tabs:
  1  Project Overview  — hero render, 4 metric cards, render thumbnails
  2  3D Viewer         — embedded model-viewer GLB + dimension panel
  3  Cost Breakdown    — donut chart, bar chart, scenario table, BOQ, download
  4  Schedule          — Gantt chart, milestones, S-curve, date slider
  5  Intelligence      — AI insight panels, What-If scenario builder

Runs outside Blender as a standard Python module.
Usage: python interactive_dashboard.py ./output
"""

import base64
import json
import os
import sys
import webbrowser

import dash
from dash import Input, Output, State, callback, dcc, html
import plotly.express as px
import plotly.graph_objects as go


# ── Brand ─────────────────────────────────────────────────────────────────────
NAVY  = "#0F1B2D"
BLUE  = "#2D7DD2"
LIGHT = "#F8F9FA"
WHITE = "#FFFFFF"
GRAY  = "#6C757D"
GREEN = "#28A745"
RED   = "#DC3545"
AMBER = "#FFC107"

PHASE_COLORS = [
    "#6B7280", "#D97706", "#DC2626",
    "#92400E", "#2563EB", "#7C3AED", "#059669",
]


# ── Helpers ───────────────────────────────────────────────────────────────────
def _money(v):
    return f"${v:,.0f}" if v else "$0"


def _img_b64(path: str) -> str | None:
    if path and os.path.exists(path):
        with open(path, "rb") as f:
            data = base64.b64encode(f.read()).decode()
        return f"data:image/png;base64,{data}"
    return None


def _card(label: str, value: str, sub: str, color: str = BLUE) -> html.Div:
    return html.Div([
        html.Div(value, style={"fontSize": "28px", "fontWeight": "bold",
                                "color": color, "lineHeight": "1.1"}),
        html.Div(label, style={"fontSize": "11px", "fontWeight": "600",
                                "color": NAVY, "marginTop": "4px"}),
        html.Div(sub,   style={"fontSize": "10px", "color": GRAY, "marginTop": "2px"}),
    ], style={
        "background": WHITE,
        "border": f"1px solid #E5E7EB",
        "borderTop": f"3px solid {color}",
        "borderRadius": "10px",
        "padding": "16px",
        "flex": "1",
        "minWidth": "150px",
        "boxShadow": "0 2px 8px rgba(0,0,0,0.06)",
    })


def _insight_panel(title: str, text: str, color: str = BLUE) -> html.Div:
    lines = [html.P(line.strip(), style={"margin": "4px 0", "lineHeight": "1.6"})
             for line in text.split("\n") if line.strip()]
    return html.Div([
        html.Div(title, style={"fontWeight": "bold", "fontSize": "13px",
                                "color": color, "marginBottom": "8px",
                                "borderBottom": f"2px solid {color}", "paddingBottom": "4px"}),
        html.Div(lines, style={"fontSize": "12px", "color": "#374151"}),
    ], style={
        "background": WHITE,
        "border": "1px solid #E5E7EB",
        "borderRadius": "10px",
        "padding": "16px",
        "marginBottom": "16px",
        "boxShadow": "0 2px 8px rgba(0,0,0,0.06)",
    })


# ── App factory ───────────────────────────────────────────────────────────────
def build_app(output_dir: str) -> dash.Dash:

    # ── Load data ─────────────────────────────────────────────────────────────
    def _load(name, default=None):
        path = os.path.join(output_dir, "data", name)
        if os.path.exists(path):
            with open(path) as f:
                return json.load(f)
        return default or {}

    quantities   = _load("quantities.json")
    cost_report  = _load("cost_report.json")
    schedule     = _load("schedule.json")
    insights     = _load("insights.json")
    meta         = quantities.get("meta", {})

    renders_dir  = os.path.join(output_dir, "renders")
    exports_dir  = os.path.join(output_dir, "exports")
    reports_dir  = os.path.join(output_dir, "reports")

    hero_img     = _img_b64(os.path.join(renders_dir, "exterior_hero.png"))
    aerial_img   = _img_b64(os.path.join(renders_dir, "aerial_45.png"))
    street_img   = _img_b64(os.path.join(renders_dir, "street_level.png"))
    interior_img = _img_b64(os.path.join(renders_dir, "interior_walkthrough.png"))

    glb_path = os.path.join(exports_dir, "scene.glb")
    glb_url  = f"/assets/scene.glb" if os.path.exists(glb_path) else None

    cost_sum = cost_report.get("summary", {})
    cr_std   = cost_report.get("standard", {})
    cr_eco   = cost_report.get("economy",  {})
    cr_prm   = cost_report.get("premium",  {})

    # ── Build app ──────────────────────────────────────────────────────────────
    app = dash.Dash(
        __name__,
        suppress_callback_exceptions=True,
        assets_folder=exports_dir,
    )
    app.title = "AXIS PERFORMANCE"

    # ─────────────────────────────────────────────────────────────────────────
    # LAYOUT
    # ─────────────────────────────────────────────────────────────────────────
    tab_style = {
        "padding": "10px 22px",
        "fontWeight": "600",
        "fontSize": "13px",
        "borderRadius": "8px 8px 0 0",
        "border": "none",
        "background": LIGHT,
        "color": GRAY,
        "cursor": "pointer",
    }
    tab_selected = {**tab_style, "background": WHITE, "color": NAVY,
                    "borderBottom": f"2px solid {BLUE}"}

    app.layout = html.Div([
        # Header
        html.Div([
            html.Span("AXIS PERFORMANCE", style={
                "fontWeight": "bold", "fontSize": "18px", "color": WHITE,
                "letterSpacing": "1px",
            }),
            html.Span("Project Intelligence Platform", style={
                "fontSize": "12px", "color": "#94A3B8", "marginLeft": "12px",
            }),
        ], style={
            "background": NAVY,
            "padding": "12px 32px",
            "display": "flex",
            "alignItems": "center",
        }),

        # Tabs
        dcc.Tabs(id="main-tabs", value="overview", children=[
            dcc.Tab(label="Project Overview", value="overview",
                    style=tab_style, selected_style=tab_selected),
            dcc.Tab(label="3D Viewer",        value="viewer3d",
                    style=tab_style, selected_style=tab_selected),
            dcc.Tab(label="Cost Breakdown",   value="cost",
                    style=tab_style, selected_style=tab_selected),
            dcc.Tab(label="Schedule",         value="schedule",
                    style=tab_style, selected_style=tab_selected),
            dcc.Tab(label="Intelligence",     value="intelligence",
                    style=tab_style, selected_style=tab_selected),
        ], style={"background": LIGHT, "paddingTop": "8px", "paddingLeft": "24px"}),

        # Tab content
        html.Div(id="tab-content", style={"padding": "24px 32px", "background": LIGHT,
                                           "minHeight": "80vh"}),

        # Stores
        dcc.Store(id="expand-img-store", data=None),
        dcc.Store(id="whatif-store",     data={"tier": "standard", "window_delta": 0}),
    ], style={"fontFamily": "'Inter', 'Segoe UI', sans-serif", "background": LIGHT})

    # ─────────────────────────────────────────────────────────────────────────
    # TAB 1 — PROJECT OVERVIEW
    # ─────────────────────────────────────────────────────────────────────────
    def _tab_overview():
        cards = html.Div([
            _card("Total Cost (Standard)", _money(cost_sum.get("standard_total", 0)),
                  f"${cost_sum.get('standard_per_sqft', 0):.0f}/sqft"),
            _card("Floor Area",
                  f"{meta.get('area_sqft', 0):,.0f} sqft",
                  f"Perimeter: {meta.get('perimeter_lf', 0):,.0f} lf"),
            _card("Project Duration",
                  f"{schedule.get('total_calendar_days', 0)} days",
                  f"{schedule.get('total_working_days', 0)} working days", color=GREEN),
            _card("Labor Hours",
                  f"{schedule.get('total_labor_hours', 0):,.0f} hrs",
                  f"{meta.get('wall_count', 0)} walls · {meta.get('room_count', 0)} rooms",
                  color=AMBER),
        ], style={"display": "flex", "gap": "16px", "flexWrap": "wrap", "marginBottom": "24px"})

        hero_section = html.Div(
            html.Img(src=hero_img, style={"width": "100%", "borderRadius": "12px",
                                           "boxShadow": "0 4px 20px rgba(0,0,0,0.12)"}),
            style={"marginBottom": "20px"}
        ) if hero_img else html.Div()

        thumbs_style = {
            "display": "grid",
            "gridTemplateColumns": "repeat(4, 1fr)",
            "gap": "12px",
            "marginTop": "16px",
        }
        thumb_imgs = []
        for label, img_data in [
            ("Exterior Hero", hero_img), ("Aerial 45°", aerial_img),
            ("Street Level", street_img), ("Interior", interior_img)
        ]:
            if img_data:
                thumb_imgs.append(html.Div([
                    html.Img(src=img_data, style={"width": "100%", "borderRadius": "8px",
                                                   "display": "block"}),
                    html.Div(label, style={"fontSize": "10px", "textAlign": "center",
                                           "color": GRAY, "marginTop": "4px"}),
                ]))
            else:
                thumb_imgs.append(html.Div([
                    html.Div(label, style={"background": "#E5E7EB", "height": "80px",
                                           "borderRadius": "8px", "display": "flex",
                                           "alignItems": "center", "justifyContent": "center",
                                           "fontSize": "11px", "color": GRAY}),
                ]))

        return html.Div([cards, hero_section, html.Div(thumb_imgs, style=thumbs_style)])

    # ─────────────────────────────────────────────────────────────────────────
    # TAB 2 — 3D VIEWER
    # ─────────────────────────────────────────────────────────────────────────
    def _tab_viewer():
        viewer_html = f"""
        <!DOCTYPE html>
        <html><head>
        <script type="module"
            src="https://ajax.googleapis.com/ajax/libs/model-viewer/3.4.0/model-viewer.min.js">
        </script>
        <style>
            model-viewer {{
                width: 100%; height: 580px;
                background: linear-gradient(160deg, #1a2a40 0%, #0f1b2d 100%);
                border-radius: 12px;
            }}
        </style>
        </head><body style="margin:0">
        <model-viewer
            src="{glb_url or ''}"
            camera-controls
            auto-rotate
            environment-image="neutral"
            shadow-intensity="1"
            exposure="1.1"
            alt="AXIS 3D Scene">
        </model-viewer>
        </body></html>
        """ if glb_url else "<div style='padding:40px;text-align:center;color:#6C757D'>3D model not yet generated — run the AXIS pipeline first.</div>"

        q_roof = quantities.get("roofing", {})
        q_wall = quantities.get("walls",   {})

        dims = html.Div([
            html.Div("Building Dimensions", style={"fontWeight": "bold", "fontSize": "13px",
                                                    "color": NAVY, "marginBottom": "12px"}),
            html.Div([
                html.Div([html.Div("Floor Area",  style={"fontSize": "11px", "color": GRAY}),
                          html.Div(f"{meta.get('area_sqft', 0):,.0f} sqft", style={"fontWeight": "bold"})]),
                html.Div([html.Div("Perimeter",   style={"fontSize": "11px", "color": GRAY}),
                          html.Div(f"{meta.get('perimeter_lf', 0):,.0f} lf", style={"fontWeight": "bold"})]),
                html.Div([html.Div("Roof Area",   style={"fontSize": "11px", "color": GRAY}),
                          html.Div(f"{q_roof.get('roof_area_sqft', 0):,.0f} sqft", style={"fontWeight": "bold"})]),
                html.Div([html.Div("Wall Area",   style={"fontSize": "11px", "color": GRAY}),
                          html.Div(f"{q_wall.get('net_wall_sqft', 0):,.0f} sqft", style={"fontWeight": "bold"})]),
                html.Div([html.Div("Roof Pitch",  style={"fontSize": "11px", "color": GRAY}),
                          html.Div(f"{meta.get('pitch_angle_deg', 35)}°", style={"fontWeight": "bold"})]),
                html.Div([html.Div("Wall Count",  style={"fontSize": "11px", "color": GRAY}),
                          html.Div(str(meta.get("wall_count", 0)), style={"fontWeight": "bold"})]),
            ], style={"display": "grid", "gridTemplateColumns": "repeat(3, 1fr)", "gap": "16px"}),
        ], style={"background": WHITE, "border": "1px solid #E5E7EB", "borderRadius": "10px",
                  "padding": "16px", "marginTop": "16px"})

        return html.Div([
            html.Iframe(srcDoc=viewer_html, style={"width": "100%", "height": "600px",
                                                     "border": "none", "borderRadius": "12px"}),
            dims,
        ])

    # ─────────────────────────────────────────────────────────────────────────
    # TAB 3 — COST BREAKDOWN
    # ─────────────────────────────────────────────────────────────────────────
    def _tab_cost():
        phases_std = cr_std.get("phases", {})
        phase_labels = {
            "phase1_foundation":   "Foundation",
            "phase2_framing":      "Framing",
            "phase3_roofing":      "Roofing",
            "phase4_ext_finishes": "Ext. Finishes",
            "phase5_int_rough":    "Int. Rough",
            "phase6_int_finishes": "Int. Finishes",
            "phase7_overhead":     "O&P",
        }

        labels = [phase_labels[k] for k in phase_labels if k in phases_std]
        totals = [phases_std[k]["total"] for k in phase_labels if k in phases_std]
        mats   = [phases_std[k].get("material", 0) for k in phase_labels if k in phases_std]
        labs   = [phases_std[k].get("labor", 0)    for k in phase_labels if k in phases_std]

        donut = go.Figure(go.Pie(
            labels=labels, values=totals,
            hole=0.55,
            marker_colors=PHASE_COLORS,
            textinfo="percent",
            hovertemplate="<b>%{label}</b><br>$%{value:,.0f}<extra></extra>",
        ))
        donut.update_layout(
            title_text="Cost by Phase",
            title_x=0.5,
            showlegend=True,
            height=340,
            margin=dict(t=50, b=10, l=10, r=10),
            paper_bgcolor=WHITE,
            plot_bgcolor=WHITE,
        )

        bar = go.Figure()
        bar.add_trace(go.Bar(name="Materials", x=labels, y=mats, marker_color=BLUE))
        bar.add_trace(go.Bar(name="Labor",     x=labels, y=labs, marker_color=NAVY))
        bar.update_layout(
            barmode="stack",
            title_text="Materials vs. Labor by Phase",
            title_x=0.5,
            height=320,
            margin=dict(t=50, b=40, l=60, r=10),
            paper_bgcolor=WHITE,
            plot_bgcolor=LIGHT,
            yaxis_tickprefix="$",
            yaxis_tickformat=",",
        )

        gauge = go.Figure(go.Indicator(
            mode="gauge+number",
            value=cost_sum.get("standard_per_sqft", 0),
            number={"prefix": "$", "suffix": "/sqft"},
            title={"text": "Cost / SqFt (Standard)"},
            gauge={
                "axis": {"range": [0, 400]},
                "bar": {"color": BLUE},
                "steps": [
                    {"range": [0, 150],   "color": "#d1fae5"},
                    {"range": [150, 250], "color": "#fef3c7"},
                    {"range": [250, 400], "color": "#fee2e2"},
                ],
                "threshold": {"line": {"color": NAVY, "width": 3}, "value": cost_sum.get("standard_per_sqft", 0)},
            },
        ))
        gauge.update_layout(height=260, margin=dict(t=40, b=10, l=20, r=20), paper_bgcolor=WHITE)

        # Scenario table
        sc_rows = [html.Tr([html.Th(h, style={"background": NAVY, "color": WHITE,
                                               "padding": "8px 12px", "fontSize": "11px"})
                            for h in ["Scenario", "Roofing", "Siding", "Total", "$/SqFt", "vs Economy"]])]
        for cr, lbl, roof, siding in [
            (cr_eco, "Economy",  "3-Tab Shingle",   "Vinyl"),
            (cr_std, "Standard", "Arch. Shingle",   "Fiber Cement"),
            (cr_prm, "Premium",  "Metal Stand. Seam", "Brick"),
        ]:
            vs = cr.get("delta", {}).get("vs_economy_dollars", 0)
            sc_rows.append(html.Tr([
                html.Td(lbl,                             style={"padding": "6px 12px", "fontWeight": "600"}),
                html.Td(roof,                            style={"padding": "6px 12px", "fontSize": "11px"}),
                html.Td(siding,                          style={"padding": "6px 12px", "fontSize": "11px"}),
                html.Td(_money(cr.get("grand_total",0)), style={"padding": "6px 12px", "fontWeight": "bold"}),
                html.Td(f"${cr.get('cost_per_sqft',0):.0f}", style={"padding": "6px 12px"}),
                html.Td(f"+{_money(vs)}" if vs > 0 else "—",
                        style={"padding": "6px 12px", "color": GREEN if vs == 0 else AMBER}),
            ]))
        sc_table = html.Table(sc_rows, style={
            "width": "100%", "borderCollapse": "collapse",
            "background": WHITE, "borderRadius": "10px", "overflow": "hidden",
            "boxShadow": "0 2px 8px rgba(0,0,0,0.06)",
        })

        return html.Div([
            html.Div([
                html.Div(dcc.Graph(figure=donut), style={"flex": "1"}),
                html.Div(dcc.Graph(figure=gauge), style={"flex": "0.6"}),
            ], style={"display": "flex", "gap": "16px"}),
            dcc.Graph(figure=bar),
            html.Div("Scenario Comparison", style={"fontWeight": "bold", "fontSize": "14px",
                                                    "color": NAVY, "margin": "16px 0 8px"}),
            sc_table,
        ])

    # ─────────────────────────────────────────────────────────────────────────
    # TAB 4 — SCHEDULE
    # ─────────────────────────────────────────────────────────────────────────
    def _tab_schedule():
        tasks = schedule.get("tasks", [])
        if not tasks:
            return html.Div("No schedule data available.", style={"color": GRAY})

        gantt_fig = go.Figure()
        for i, task in enumerate(tasks):
            gantt_fig.add_trace(go.Bar(
                name=task["label"],
                x=[task["duration_days"]],
                y=[task["label"]],
                orientation="h",
                base=[(task["start_date"])],
                marker_color=task.get("color", PHASE_COLORS[i % len(PHASE_COLORS)]),
                hovertemplate=(
                    f"<b>{task['label']}</b><br>"
                    f"Start: {task['start_date']}<br>"
                    f"End: {task['end_date']}<br>"
                    f"Duration: {task['duration_days']} days<br>"
                    f"Labor: {task['labor_hours']:,.0f} hrs<extra></extra>"
                ),
            ))

        gantt_fig.update_layout(
            title_text="Construction Gantt Chart",
            barmode="overlay",
            height=380,
            margin=dict(t=50, b=40, l=160, r=20),
            xaxis_title="Date",
            paper_bgcolor=WHITE,
            plot_bgcolor=LIGHT,
            showlegend=False,
        )

        # Milestones
        ms_rows = [html.Tr([html.Th(h, style={"background": NAVY, "color": WHITE,
                                               "padding": "8px 12px", "fontSize": "11px"})
                            for h in ["Milestone", "Date"]])]
        for ms in schedule.get("milestones", []):
            ms_rows.append(html.Tr([
                html.Td(ms["label"], style={"padding": "6px 12px"}),
                html.Td(ms["date"],  style={"padding": "6px 12px", "fontWeight": "bold", "color": BLUE}),
            ]))
        ms_table = html.Table(ms_rows, style={
            "width": "100%", "borderCollapse": "collapse",
            "background": WHITE, "borderRadius": "10px",
            "boxShadow": "0 2px 8px rgba(0,0,0,0.06)", "marginTop": "16px",
        })

        # S-Curve (cumulative labor hours)
        cum = 0
        s_x, s_y, s_labels = [], [], []
        for t in tasks:
            cum += t["labor_hours"]
            s_x.append(t["end_date"])
            s_y.append(cum)
            s_labels.append(t["label"])

        s_curve = go.Figure(go.Scatter(
            x=s_x, y=s_y, mode="lines+markers",
            line=dict(color=BLUE, width=2.5),
            marker=dict(color=NAVY, size=7),
            text=s_labels,
            hovertemplate="<b>%{text}</b><br>Cumulative: %{y:,.0f} hrs<extra></extra>",
            fill="tozeroy", fillcolor="rgba(45,125,210,0.08)",
        ))
        s_curve.update_layout(
            title_text="S-Curve (Cumulative Labor Hours)",
            height=280,
            margin=dict(t=50, b=40, l=60, r=20),
            paper_bgcolor=WHITE,
            plot_bgcolor=LIGHT,
            yaxis_title="Cumulative Labor Hours",
        )

        return html.Div([
            dcc.Graph(figure=gantt_fig),
            ms_table,
            dcc.Graph(figure=s_curve),
        ])

    # ─────────────────────────────────────────────────────────────────────────
    # TAB 5 — INTELLIGENCE
    # ─────────────────────────────────────────────────────────────────────────
    def _tab_intelligence():
        ins = insights

        panels = html.Div([
            _insight_panel("Project Summary",          ins.get("project_summary", ""), NAVY),
            _insight_panel("Cost Analysis",            ins.get("cost_analysis", ""),   BLUE),
            _insight_panel("Material Recommendations", ins.get("material_recommendations", ""), GREEN),
            _insight_panel("Schedule Risk Assessment", ins.get("schedule_risks", ""),  AMBER),
            _insight_panel("Pre-Construction Checklist", ins.get("quality_checklist", ""), RED),
        ])

        # What-If builder
        tier_options = [
            {"label": "Economy",  "value": "economy"},
            {"label": "Standard", "value": "standard"},
            {"label": "Premium",  "value": "premium"},
        ]

        whatif = html.Div([
            html.Div("What-If Scenario Builder", style={"fontWeight": "bold", "fontSize": "14px",
                                                         "color": NAVY, "marginBottom": "16px"}),
            html.Div("Quality Tier:", style={"fontSize": "12px", "marginBottom": "6px"}),
            dcc.Dropdown(id="tier-dropdown", options=tier_options, value="standard",
                         clearable=False, style={"marginBottom": "16px", "fontSize": "12px"}),
            html.Div("Window Count Adjustment:", style={"fontSize": "12px", "marginBottom": "6px"}),
            dcc.Slider(id="window-slider", min=-4, max=8, step=1, value=0,
                       marks={i: str(i) for i in range(-4, 9)},
                       tooltip={"placement": "bottom", "always_visible": False}),
            html.Div(id="whatif-result", style={"marginTop": "20px", "padding": "16px",
                                                  "background": LIGHT, "borderRadius": "10px",
                                                  "border": "1px solid #E5E7EB"}),
        ], style={"background": WHITE, "border": "1px solid #E5E7EB", "borderRadius": "10px",
                  "padding": "20px", "marginBottom": "24px",
                  "boxShadow": "0 2px 8px rgba(0,0,0,0.06)"})

        return html.Div([whatif, panels])

    # ─────────────────────────────────────────────────────────────────────────
    # CALLBACKS
    # ─────────────────────────────────────────────────────────────────────────
    @app.callback(
        Output("tab-content", "children"),
        Input("main-tabs", "value"),
    )
    def render_tab(tab):
        if tab == "overview":    return _tab_overview()
        if tab == "viewer3d":    return _tab_viewer()
        if tab == "cost":        return _tab_cost()
        if tab == "schedule":    return _tab_schedule()
        if tab == "intelligence": return _tab_intelligence()
        return html.Div("Tab not found.")

    @app.callback(
        Output("whatif-result", "children"),
        Input("tier-dropdown",  "value"),
        Input("window-slider",  "value"),
    )
    def update_whatif(tier, window_delta):
        from cost_engine import calculate_costs
        from quantity_takeoff import calculate_quantities

        if not quantities:
            return html.Div("No project data loaded.", style={"color": GRAY})

        # Clone scene_data-compatible quantities (rebuild from stored quantities)
        # Apply window delta
        modified_qty = json.loads(json.dumps(quantities))
        curr_windows = modified_qty["openings"]["window_count"]
        modified_qty["openings"]["window_count"] = max(0, curr_windows + (window_delta or 0))

        try:
            cr = calculate_costs(modified_qty)
            chosen = cr.get(tier or "standard", {})
            total  = chosen.get("grand_total", 0)
            psf    = chosen.get("cost_per_sqft", 0)
            base   = cost_report.get(tier or "standard", {}).get("grand_total", total)
            delta  = total - base

            return html.Div([
                html.Div(f"{(tier or 'standard').title()} Scenario", style={"fontWeight": "bold",
                                                                             "color": NAVY, "marginBottom": "8px"}),
                html.Div([
                    html.Span("Grand Total: ", style={"fontSize": "12px", "color": GRAY}),
                    html.Span(_money(total), style={"fontWeight": "bold", "fontSize": "18px",
                                                     "color": BLUE, "marginLeft": "8px"}),
                ]),
                html.Div([
                    html.Span("Cost/SqFt: ", style={"fontSize": "12px", "color": GRAY}),
                    html.Span(f"${psf:.0f}", style={"fontWeight": "bold", "fontSize": "14px",
                                                     "marginLeft": "8px"}),
                ]),
                html.Div([
                    html.Span("vs. Original: ", style={"fontSize": "12px", "color": GRAY}),
                    html.Span(f"+{_money(delta)}" if delta >= 0 else _money(delta),
                              style={"fontWeight": "bold", "fontSize": "14px",
                                     "color": GREEN if delta <= 0 else AMBER, "marginLeft": "8px"}),
                ]) if delta != 0 else html.Div(),
                html.Div(f"Windows: {modified_qty['openings']['window_count']} total",
                         style={"fontSize": "11px", "color": GRAY, "marginTop": "8px"}),
            ])
        except Exception as e:
            return html.Div(f"Calculation error: {e}", style={"color": RED})

    return app


# ── Entry point ───────────────────────────────────────────────────────────────
def launch_dashboard(output_dir: str, port: int = 8050, open_browser: bool = True) -> None:
    app = build_app(output_dir)
    url = f"http://127.0.0.1:{port}"
    print(f"[AXIS Dashboard] Starting at {url}")
    if open_browser:
        import threading
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    app.run(debug=False, host="127.0.0.1", port=port)


if __name__ == "__main__":
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "output"
    port    = int(sys.argv[2]) if len(sys.argv) > 2 else 8050
    launch_dashboard(out_dir, port=port)
