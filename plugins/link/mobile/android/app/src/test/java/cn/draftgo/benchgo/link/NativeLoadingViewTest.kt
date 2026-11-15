package cn.draftgo.benchgo.link

import org.junit.Assert.*
import org.junit.Test

class NativeLoadingViewTest {
    @Test fun shortLabelsUseSharedLoadingCycleAndLongLabelsHaveRoomToFinish() {
        assertEquals(1600L, loadingCycleMillis(7))
        assertEquals(2300L, loadingCycleMillis(20))
    }

    @Test fun glyphsHaveShortSequentialHighlightAndLiftWithoutMovingTheLine() {
        assertEquals(LoadingGlyphFrame(.56f, 0f), loadingGlyphFrame(74f, 1, 7, true))
        assertEquals(LoadingGlyphFrame(1f, 2f), loadingGlyphFrame(80f, 0, 7, true))
        assertEquals(LoadingGlyphFrame(1f, 2f), loadingGlyphFrame(155f, 1, 7, true))
        assertEquals(LoadingGlyphFrame(.94f, 0f), loadingGlyphFrame(176f, 0, 7, true))
        assertEquals(LoadingGlyphFrame(.56f, 0f), loadingGlyphFrame(800f, 0, 7, true))
        assertEquals(LoadingGlyphFrame(1f, 2f), loadingGlyphFrame(1680f, 0, 7, true))
    }

    @Test fun disabledMotionAlwaysKeepsEveryCharacterFullyVisibleAndStill() {
        for (elapsed in listOf(0f, 80f, 800f, 1680f)) for (index in 0..6) {
            assertEquals(LoadingGlyphFrame(1f, 0f), loadingGlyphFrame(elapsed, index, 7, false))
        }
    }
}
