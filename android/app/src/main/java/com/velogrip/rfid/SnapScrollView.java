package com.velogrip.rfid;

import android.content.Context;
import android.util.AttributeSet;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.HorizontalScrollView;

/**
 * A horizontal pager: its single child is a row of full-width pages. Dragging
 * follows the finger (the next page peeks in), and on release it snaps to the
 * nearest page — no momentum fling carrying past it. Zero-dependency stand-in
 * for ViewPager (the app avoids AndroidX).
 */
public class SnapScrollView extends HorizontalScrollView {

    public interface OnPage { void onPage(int page); }

    private OnPage onPage;

    public SnapScrollView(Context c) { super(c); init(); }
    public SnapScrollView(Context c, AttributeSet a) { super(c, a); init(); }

    private void init() {
        setHorizontalScrollBarEnabled(false);
        setOverScrollMode(OVER_SCROLL_NEVER);
    }

    public void setOnPage(OnPage p) { onPage = p; }

    private int pageWidth() { return Math.max(1, getWidth()); }

    public int pageCount() {
        if (getChildCount() == 0) return 1;
        View inner = getChildAt(0);
        return inner instanceof ViewGroup ? Math.max(1, ((ViewGroup) inner).getChildCount()) : 1;
    }

    public int currentPage() {
        return clamp(Math.round(getScrollX() / (float) pageWidth()));
    }

    private int clamp(int p) { return Math.max(0, Math.min(pageCount() - 1, p)); }

    /** Scroll to a page; animate for user gestures, jump when re-rendering. */
    public void goToPage(int p, boolean animate) {
        p = clamp(p);
        int x = p * pageWidth();
        if (animate) smoothScrollTo(x, 0); else scrollTo(x, 0);
        if (onPage != null) onPage.onPage(p);
    }

    // Kill the momentum fling so a flick can't skip past the adjacent page;
    // the snap happens on touch-up instead.
    @Override public void fling(int velocityX) { }

    @Override
    public boolean onTouchEvent(MotionEvent ev) {
        boolean handled = super.onTouchEvent(ev);
        int action = ev.getActionMasked();
        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            goToPage(currentPage(), true); // snap to whichever page you released on
        }
        return handled;
    }
}
