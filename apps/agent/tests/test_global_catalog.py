import asyncio
import unittest
from unittest.mock import AsyncMock

from benchy_catalog import GlobalCatalog, global_profiles


class CatalogTest(unittest.IsolatedAsyncioTestCase):
    async def test_on_demand_only_active_global_and_only_successful(self):
        rows = [dict(inferenceProfileId=i, status=s, inferenceProfileName=i) for i,s in [
            ("global.one", "ACTIVE"), ("global.two", "ACTIVE"),
            ("global.retired", "INACTIVE"), ("us.one", "ACTIVE"), ("bare", "ACTIVE")]]
        list_profiles = AsyncMock(side_effect=lambda: global_profiles([{"inferenceProfileSummaries": rows[:2]}, {"inferenceProfileSummaries": rows[2:]}]))
        probe = AsyncMock(side_effect=lambda model: model == "global.one")
        subject = GlobalCatalog(list_profiles, probe)
        self.assertFalse(list_profiles.called)
        a,b = await asyncio.gather(subject.get(), subject.get())
        self.assertEqual(a, b)
        self.assertEqual(a["models"], ["global.one"])
        self.assertEqual([m["id"] for m in a["catalog"]], a["models"])
        list_profiles.assert_awaited_once()
        self.assertCountEqual([c.args[0] for c in probe.await_args_list], ["global.one", "global.two"])
        self.assertEqual(await subject.get(), a)
        list_profiles.assert_awaited_once()

    async def test_discovery_error_is_not_cached_as_empty(self):
        discover = AsyncMock(side_effect=[RuntimeError("denied"), {}])
        subject = GlobalCatalog(discover, AsyncMock())
        with self.assertRaises(RuntimeError):
            await subject.get()
        self.assertEqual((await subject.get())["models"], [])
        self.assertEqual(discover.await_count, 2)
