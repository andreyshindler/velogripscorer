package com.velogrip.rfid;

import android.text.InputType;
import android.text.method.PasswordTransformationMethod;
import android.widget.CompoundButton;
import android.widget.EditText;

/**
 * Wires a "Show password" checkbox to a password {@link EditText}: checked
 * reveals the characters, unchecked masks them again. The cursor is preserved
 * across the toggle so typing isn't interrupted. Works without AndroidX.
 */
public final class PasswordReveal {

    private PasswordReveal() { }

    /** Attach the reveal toggle. Starts masked (checkbox unchecked). */
    public static void attach(CompoundButton toggle, final EditText field) {
        toggle.setChecked(false);
        toggle.setOnCheckedChangeListener((CompoundButton b, boolean show) -> {
            int start = field.getSelectionStart();
            int end = field.getSelectionEnd();
            if (show) {
                field.setInputType(InputType.TYPE_CLASS_TEXT
                        | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
            } else {
                field.setInputType(InputType.TYPE_CLASS_TEXT
                        | InputType.TYPE_TEXT_VARIATION_PASSWORD);
                field.setTransformationMethod(PasswordTransformationMethod.getInstance());
            }
            field.setSelection(start, end); // keep the caret where it was
        });
    }
}
