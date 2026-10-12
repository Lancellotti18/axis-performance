"""One physical roof line, one side — Ryan's house, 2026-10-12.

Its facet A came back with a straight eave in six pieces (2.9, 22.5, 3.3, 3.4,
11.9, 21.4 ft, bending only 5-20 degrees between them) and a hip as
hip 10.2 ft / "rake" 1.9 ft / hip 8.2 ft. Every piece was labelled and
reviewed on its own."""
from app.services.roof_from_dsm import _merge_fragments

PX = 0.1                                   # metres per pixel
NB = 7                                     # the facet across the hip
EAVE, HIP, RAKE = ("eave", None), ("hip", NB), ("rake", None)


def _facet():
    # A trapezoid-ish plane: a wavy eave along the bottom, a hip up the right
    # side with a short "rake" fragment in it, a ridge across the top, a rake
    # down the left.
    pts = [
        (0, 0), (90, 2), (300, -1), (330, 2), (360, 0), (480, 1),   # wavy eave (y ~ 0)
        (600, 0),                                                    # eave ends, hip starts
        (520, 100), (516.4, 104.8),                                # hip ... 0.6 m (1.9 ft) "rake" ... hip
        (450, 190),                                                  # hip ends at the ridge
        (150, 190),                                                  # ridge
    ]
    sides = [EAVE] * 6 + [HIP, RAKE, HIP, ("ridge", 9), RAKE]
    return pts, sides


def test_a_wavy_eave_becomes_one_eave():
    pts, sides = _merge_fragments(*_facet(), PX)
    assert sides.count(EAVE) == 1


def test_a_rake_fragment_inside_a_hip_is_hip_and_the_hip_is_one_line():
    pts, sides = _merge_fragments(*_facet(), PX)
    assert sides.count(HIP) == 1
    # The only rake left is the real one down the left side.
    assert sides.count(RAKE) == 1


def test_real_corners_survive():
    pts, sides = _merge_fragments(*_facet(), PX)
    # eave, hip, ridge, rake: the four real sides, nothing else.
    assert len(pts) == 4
    assert [s[0] for s in sides] == ["eave", "hip", "ridge", "rake"]


def test_a_real_bend_in_a_line_is_kept():
    """A bay that steps the eave out by 2 m is a real corner, not a wobble."""
    pts = [(0, 0), (200, 0), (220, 20), (400, 20), (400, 200), (0, 200)]
    sides = [EAVE, EAVE, EAVE, RAKE, ("ridge", 9), RAKE]
    out_pts, out_sides = _merge_fragments(pts, sides, PX)
    assert len(out_pts) == 6


def test_different_lines_meeting_in_a_straight_line_stay_separate():
    """An eave running straight on into a different facet's line is still two."""
    pts = [(0, 0), (200, 0), (400, 0), (400, 200), (0, 200)]
    sides = [EAVE, ("wall_intersection", 3), RAKE, ("ridge", 9), RAKE]
    out_pts, out_sides = _merge_fragments(pts, sides, PX)
    assert len(out_pts) == 5
