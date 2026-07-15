package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.velogrip.rfid.db.RaceStore;

import java.util.List;

/**
 * Category setup: the categories drawn from the start list, curated for
 * category results. A green ✓ marks an included category; tapping toggles it.
 * Edit adds a new category; Delete removes the tapped one (delete mode).
 */
public class CategorySetupActivity extends BaseActivity {

    private RaceStore store;
    private LinearLayout box;
    private TextView hint, editLabel;
    private boolean deleteMode;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_category_setup);
        store = new RaceStore(this);
        store.seedCategoriesFromStartList();

        WizardNav.attach(this, WizardNav.CATEGORY_SETUP);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setVisibility(View.VISIBLE);
        findViewById(R.id.nextButton).setOnClickListener(v ->
                startActivity(new Intent(this, RacerSetupActivity.class)));

        box = findViewById(R.id.categoriesBox);
        hint = findViewById(R.id.categoryHint);
        editLabel = findViewById(R.id.editLabel);

        findViewById(R.id.navSettings).setOnClickListener(v ->
                startActivity(new Intent(this, SettingsActivity.class)));
        findViewById(R.id.navEdit).setOnClickListener(v -> {
            if (deleteMode) { deleteMode = false; render(); }  // Done
            else addCategory();
        });
        findViewById(R.id.navDelete).setOnClickListener(v -> {
            deleteMode = !deleteMode;
            Toast.makeText(this, deleteMode ? R.string.delete_tap_category : R.string.delete_off,
                    Toast.LENGTH_SHORT).show();
            render();
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
    }

    private void render() {
        box.removeAllViews();
        List<RaceStore.Category> categories = store.categories();
        for (final RaceStore.Category cat : categories) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(12), dp(18), dp(12), dp(18));
            android.util.TypedValue tv = new android.util.TypedValue();
            getTheme().resolveAttribute(android.R.attr.selectableItemBackground, tv, true);
            row.setBackgroundResource(tv.resourceId);

            TextView check = new TextView(this);
            check.setText(deleteMode ? "🗑" : "✓");
            check.setTextColor(deleteMode ? 0xFFC0392B : (cat.enabled ? 0xFF76B82A : 0xFFBBBBBB));
            check.setTextSize(18);
            check.setTypeface(null, android.graphics.Typeface.BOLD);
            check.setLayoutParams(new LinearLayout.LayoutParams(dp(34), LinearLayout.LayoutParams.WRAP_CONTENT));

            TextView name = new TextView(this);
            name.setText(cat.name);
            name.setTextColor(cat.enabled ? getColor(R.color.text_primary) : getColor(R.color.text_muted));
            name.setTextSize(19);
            name.setTypeface(null, android.graphics.Typeface.BOLD);
            name.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

            row.addView(check);
            row.addView(name);
            row.setOnClickListener(v -> {
                if (deleteMode) {
                    new android.app.AlertDialog.Builder(this)
                            .setMessage(getString(R.string.delete_category_confirm, cat.name))
                            .setPositiveButton(android.R.string.ok, (d, w) -> {
                                store.deleteCategory(cat.name);
                                deleteMode = false;
                                render();
                            })
                            .setNegativeButton(android.R.string.cancel, null)
                            .show();
                } else {
                    store.setCategoryEnabled(cat.name, !cat.enabled);
                    render();
                }
            });
            box.addView(row);

            View divider = new View(this);
            divider.setBackgroundColor(getColor(R.color.divider));
            divider.setLayoutParams(new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, 1));
            box.addView(divider);
        }

        hint.setText(getString(R.string.categories_hint, categories.size()));
        editLabel.setText(deleteMode ? R.string.action_done : R.string.action_edit);
    }

    private void addCategory() {
        final EditText input = new EditText(this);
        input.setHint(R.string.category_name_hint);
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.add_category)
                .setView(input)
                .setPositiveButton(android.R.string.ok, (d, w) -> {
                    String name = input.getText().toString().trim();
                    if (!name.isEmpty()) {
                        store.addCategory(name);
                        render();
                    }
                })
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        store.close();
    }
}
