"""The imagery cache holds raw tile bytes. Bounding it by entry count let it reach
~469 MB (256 x 1.8 MB) on a 512 MB instance, which is what OOM-killed the service.
These pin the byte bound."""
from app.services import imagery_service as imx


def _entry(nbytes: int, t: float):
    return imx._CacheEntry(bytes=b"\x00" * nbytes, media_type="image/png",
                           health=1.0, provider="esri", warnings=[], fetched_at=t)


def test_cache_stays_under_the_byte_budget():
    imx._CACHE.clear()
    # 60 realistic 1.8 MB tiles = 108 MB unbounded.
    for i in range(60):
        imx._cache_put(f"k{i}", _entry(1_800_000, float(i)))
    assert imx._cache_bytes() <= imx._CACHE_MAX_BYTES, (
        f"cache holds {imx._cache_bytes() / 1e6:.0f} MB, budget is "
        f"{imx._CACHE_MAX_BYTES / 1e6:.0f} MB")
    imx._CACHE.clear()


def test_a_burst_claws_memory_back_in_one_insert():
    """The old code evicted ONE entry per insert, so a burst of large tiles could
    never recover. Eviction must drain until the budget is met."""
    imx._CACHE.clear()
    for i in range(40):
        imx._CACHE[f"pre{i}"] = _entry(1_800_000, float(i))   # 72 MB, over budget
    imx._cache_put("new", _entry(1_800_000, 999.0))
    assert imx._cache_bytes() <= imx._CACHE_MAX_BYTES
    assert "new" in imx._CACHE, "the just-inserted tile must survive eviction"
    imx._CACHE.clear()


def test_many_small_tiles_still_bounded_by_count():
    imx._CACHE.clear()
    for i in range(500):
        imx._cache_put(f"s{i}", _entry(1_000, float(i)))
    assert len(imx._CACHE) <= imx._CACHE_MAX_ENTRIES
    imx._CACHE.clear()


def test_budget_fits_the_instance():
    """Cache budget must leave room for the interpreter and in-flight requests."""
    assert imx._CACHE_MAX_BYTES <= 64 * 1024 * 1024
