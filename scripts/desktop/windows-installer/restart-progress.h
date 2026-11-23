#pragma once

namespace benchgo_restart_progress {
constexpr UINT_PTR timer = 1;

inline void Paint(HDC dc, const RECT& track, bool dark, ULONGLONG started) {
    const int width = track.right - track.left;
    const int segmentWidth = width / 3;
    const auto brush = static_cast<HBRUSH>(GetStockObject(DC_BRUSH));
    SetDCBrushColor(dc, dark ? RGB(58, 64, 68) : RGB(206, 215, 219));
    FillRect(dc, &track, brush);
    if (!started) return;

    constexpr ULONGLONG cycleMs = 1500;
    const ULONGLONG elapsed = (GetTickCount64() - started) % cycleMs;
    const int left = track.left - segmentWidth + static_cast<int>(elapsed * (width + segmentWidth) / cycleMs);
    RECT segment{std::max<LONG>(track.left, left), track.top,
        std::min<LONG>(track.right, left + segmentWidth), track.bottom};
    SetDCBrushColor(dc, dark ? RGB(119, 224, 219) : RGB(0, 122, 134));
    FillRect(dc, &segment, brush);
}
}
