#!/usr/bin/env python3
"""
APIR accuracy check — CLI tool for diagnosing report quality.

Two modes:

  # Default: run against the test fixture (no DB, no AI)
  python3 backend/scripts/apir_accuracy_check.py

  # Against a real report stored in production Supabase:
  python3 backend/scripts/apir_accuracy_check.py <report_id>

Prints the same diagnostic the /accuracy endpoint returns, formatted for
the terminal. Useful for:
  * Spot-checking the accuracy logic during development
  * Triaging a customer-reported issue by report_id
  * Bulk-grading a batch of reports during accuracy verification week
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path


def _bootstrap_imports() -> None:
    """Allow `python3 scripts/apir_accuracy_check.py` from the repo root."""
    backend_dir = Path(__file__).resolve().parent.parent
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))


_bootstrap_imports()


from app.schemas.apir import PropertyMeasurements  # noqa: E402
from app.services.report.accuracy_report import compute_accuracy_report  # noqa: E402


# ─── Pretty-printing ─────────────────────────────────────────────────

RESET = "\033[0m"
BOLD = "\033[1m"
GREEN = "\033[32m"
BLUE = "\033[34m"
AMBER = "\033[33m"
RED = "\033[31m"
DIM = "\033[2m"


def _conf_color(conf: str) -> str:
    return {
        "high": GREEN, "medium": AMBER, "estimated": RED,
    }.get(conf, "")


def _grade_color(grade: str) -> str:
    return {
        "A": GREEN, "B": BLUE, "C": AMBER, "D": RED,
    }.get(grade, "")


def _print_report(report) -> None:
    print()
    print(f"{BOLD}APIR Accuracy Report{RESET}")
    print(f"{DIM}─" * 60 + RESET)
    print(f"  report_id: {report.report_id}")
    print(f"  version:   v{report.version}")
    print(
        f"  grade:     {_grade_color(report.overall_grade)}{BOLD}"
        f"{report.overall_grade}{RESET}  "
        f"({_conf_color(report.overall_confidence)}{report.overall_confidence}{RESET}, "
        f"score {report.overall_score:.2f})"
    )
    print(f"  summary:   {report.summary}")
    print()

    print(f"{BOLD}Per-category breakdown{RESET}")
    print(f"  {'category':14s}  {'confidence':12s}  {'samples':>7s}  {'target':>7s}  note")
    print(f"  {'─' * 12:14s}  {'─' * 10:12s}  {'─' * 7:>7s}  {'─' * 6:>7s}  {'─' * 30}")
    for c in report.categories:
        color = _conf_color(c.confidence)
        print(
            f"  {c.category:14s}  "
            f"{color}{c.confidence:12s}{RESET}  "
            f"{c.sample_count:>7d}  "
            f"±{c.target_pct_error:>5.1f}%  {c.note}"
        )
    print()

    if report.flagged_items:
        print(f"{BOLD}Flagged items ({len(report.flagged_items)}){RESET}")
        for f in report.flagged_items:
            color = _conf_color(f.confidence)
            target = f" ({f.target_id})" if f.target_id else ""
            print(f"  {color}[{f.confidence:9s}]{RESET} {f.label}{target}")
            if f.value:
                print(f"               value: {f.value}")
            print(f"               action: {DIM}{f.recommendation}{RESET}")
        print()
    else:
        print(f"{GREEN}{BOLD}No items flagged for review.{RESET}\n")

    print(f"{BOLD}On-site verification checklist{RESET}")
    for check in report.on_site_checks:
        print(f"  ☐ {check}")
    print()


# ─── Modes ────────────────────────────────────────────────────────────

def _run_against_fixture() -> None:
    """Mode 1: load the test fixture, no DB."""
    from app.services.report.test_fixtures import build_apir_test_property

    print(f"{DIM}Running against APIR_TEST_PROPERTY (no DB, no AI calls){RESET}")
    pm = build_apir_test_property()
    report = compute_accuracy_report(pm, report_id="apir-test-property")
    _print_report(report)


def _run_against_report_id(report_id: str) -> None:
    """Mode 2: pull a real report's measurements_snapshot from Supabase."""
    try:
        from app.core.supabase import get_supabase
    except Exception as e:
        print(f"{RED}Could not import Supabase client: {e}{RESET}")
        sys.exit(1)

    db = get_supabase()
    res = (
        db.table("apir_reports")
        .select("id,version,measurements_snapshot")
        .eq("id", report_id)
        .limit(1)
        .execute()
    )
    rows = getattr(res, "data", None) or []
    if not rows:
        print(f"{RED}No apir_reports row found with id={report_id}{RESET}")
        sys.exit(1)
    row = rows[0]
    snapshot = row.get("measurements_snapshot")
    if not snapshot:
        print(f"{RED}Report {report_id} has no measurements_snapshot.{RESET}")
        sys.exit(1)
    pm = PropertyMeasurements.model_validate(snapshot)
    report = compute_accuracy_report(pm, report_id=report_id)
    _print_report(report)


# ─── Entry point ──────────────────────────────────────────────────────

def main() -> None:
    if len(sys.argv) == 1:
        _run_against_fixture()
        return
    if len(sys.argv) == 2:
        report_id = sys.argv[1]
        _run_against_report_id(report_id)
        return
    print(__doc__)
    sys.exit(2)


if __name__ == "__main__":
    main()
