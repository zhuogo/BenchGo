package cn.draftgo.benchgo.link

import android.animation.ValueAnimator
import android.content.Context
import android.database.ContentObserver
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.view.animation.LinearInterpolator
import android.view.animation.PathInterpolator
import kotlin.math.max

internal fun loadingCycleMillis(characterCount: Int): Long = max(1600L, characterCount * 75L + 800L)

internal data class LoadingGlyphFrame(val alpha: Float, val lift: Float)

/** Matches shared ui/loading.css: 75ms stagger, short highlight and 2dp lift. */
internal fun loadingGlyphFrame(elapsed: Float, index: Int, count: Int, animated: Boolean,
    ease: (Float) -> Float = { it }): LoadingGlyphFrame {
    if (!animated) return LoadingGlyphFrame(1f, 0f)
    val delayed = elapsed - index * 75f
    if (delayed < 0) return LoadingGlyphFrame(.56f, 0f)
    val phase = delayed % loadingCycleMillis(count) / loadingCycleMillis(count)
    fun between(start: Float, end: Float, from: Float, to: Float): Float =
        from + (to - from) * ease(((phase - start) / (end - start)).coerceIn(0f, 1f))
    return when {
        phase < .05f -> LoadingGlyphFrame(between(0f, .05f, .56f, 1f), between(0f, .05f, 0f, 2f))
        phase < .11f -> LoadingGlyphFrame(between(.05f, .11f, 1f, .94f), between(.05f, .11f, 2f, 0f))
        phase < .22f -> LoadingGlyphFrame(between(.11f, .22f, .94f, .56f), 0f)
        else -> LoadingGlyphFrame(.56f, 0f)
    }
}

/** One native view and one animator; no spinner, web runtime or per-letter views. */
internal class NativeLoadingView(context: Context) : View(context) {
    private val label = "正在连接设备…"
    private val glyphs = label.map(Char::toString)
    private val density = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 13f * resources.displayMetrics.scaledDensity
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    }
    private val widths = glyphs.map(paint::measureText)
    private val textWidth = widths.sum()
    private val metrics = paint.fontMetrics
    private val ease = PathInterpolator(.2f, .65f, .3f, 1f)
    private val easing: (Float) -> Float = ease::getInterpolation
    private var animator: ValueAnimator? = null
    private var elapsed = 0f
    private var resumed = false
    private var initialized = false
    private var observing = false
    private var closed = false
    private val motionObserver = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) { updateAnimation() }
    }

    init {
        visibility = GONE
        isClickable = true
        contentDescription = label
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        accessibilityLiveRegion = ACCESSIBILITY_LIVE_REGION_POLITE
        initialized = true
    }

    fun setAppearance(appearance: PageAppearance) {
        setBackgroundColor(appearance.background)
        paint.color = appearance.foreground
        invalidate()
    }

    fun setLoading(loading: Boolean) { visibility = if (loading && !closed) VISIBLE else GONE }
    fun setResumed(value: Boolean) { resumed = value; updateAnimation() }

    private fun updateAnimation() {
        if (!initialized) return
        val animate = !closed && resumed && isAttachedToWindow && isShown && windowVisibility == VISIBLE && ValueAnimator.areAnimatorsEnabled()
        if (animate && animator == null) {
            animator = ValueAnimator.ofFloat(0f, loadingCycleMillis(glyphs.size).toFloat()).apply {
                duration = loadingCycleMillis(glyphs.size)
                repeatCount = ValueAnimator.INFINITE
                interpolator = LinearInterpolator()
                addUpdateListener { elapsed = it.animatedValue as Float; invalidate() }
                start()
            }
        } else if (!animate && animator != null) {
            animator?.cancel(); animator?.removeAllUpdateListeners(); animator = null
            elapsed = 0f; invalidate()
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val baseline = height / 2f - (metrics.ascent + metrics.descent) / 2f
        var x = (width - textWidth) / 2f
        glyphs.forEachIndexed { index, glyph ->
            val frame = loadingGlyphFrame(elapsed, index, glyphs.size, animator != null, easing)
            paint.alpha = (frame.alpha * 255).toInt()
            canvas.drawText(glyph, x, baseline - frame.lift * density, paint)
            x += widths[index]
        }
        paint.alpha = 255
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (!closed) {
            context.contentResolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, motionObserver)
            observing = true
        }
        updateAnimation()
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        updateAnimation()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        updateAnimation()
    }

    override fun onDetachedFromWindow() {
        if (observing) { context.contentResolver.unregisterContentObserver(motionObserver); observing = false }
        animator?.cancel(); animator?.removeAllUpdateListeners(); animator = null
        elapsed = 0f
        super.onDetachedFromWindow()
    }

    fun close() {
        closed = true
        setLoading(false)
        updateAnimation()
        if (observing) { context.contentResolver.unregisterContentObserver(motionObserver); observing = false }
    }
}
