package com.velogrip.rfid;

import android.content.Context;
import android.util.AttributeSet;
import android.view.MotionEvent;
import android.view.ViewConfiguration;
import android.widget.LinearLayout;

/**
 * A bottom bar whose two pages you can flip by swiping horizontally, in
 * addition to tapping "More". A short press falls through to the action button
 * underneath (we only intercept once a finger has clearly dragged sideways),
 * so taps still work; a horizontal drag past the touch slop fires onSwipe.
 */
public class SwipeBar extends LinearLayout {

    public interface OnSwipe { void onSwipe(); }

    private OnSwipe onSwipe;
    private float downX, downY;
    private int touchSlop;

    public SwipeBar(Context c) { super(c); init(c); }
    public SwipeBar(Context c, AttributeSet a) { super(c, a); init(c); }

    private void init(Context c) {
        touchSlop = ViewConfiguration.get(c).getScaledTouchSlop();
    }

    public void setOnSwipe(OnSwipe s) { onSwipe = s; }

    @Override
    public boolean onInterceptTouchEvent(MotionEvent ev) {
        switch (ev.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = ev.getX();
                downY = ev.getY();
                break;
            case MotionEvent.ACTION_MOVE:
                float dx = Math.abs(ev.getX() - downX);
                float dy = Math.abs(ev.getY() - downY);
                if (dx > touchSlop && dx > dy) return true; // it's a sideways drag
                break;
        }
        return false;
    }

    @Override
    public boolean onTouchEvent(MotionEvent ev) {
        switch (ev.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = ev.getX();
                return true;
            case MotionEvent.ACTION_UP:
                if (Math.abs(ev.getX() - downX) > touchSlop && onSwipe != null) onSwipe.onSwipe();
                break;
        }
        return true;
    }
}
