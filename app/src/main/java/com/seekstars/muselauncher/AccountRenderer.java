package com.seekstars.muselauncher;

import android.app.Activity;
import android.content.ClipData;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.text.Editable;
import android.text.InputFilter;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.view.DragEvent;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import java.util.ArrayList;
import java.util.List;

/** Owns the rail/list, organization controls and dialogs; navigation stays in the host. */
public final class AccountRenderer {
    public interface Callbacks {
        void select(long id);
        void configure(long id);
        /** Called only after confirmation; host removes metadata and the WebView profile. */
        void delete(long id);
        void shortcut(long id);
        /** Refresh external labels (shortcuts/notification) after account metadata changes. */
        default void metadataChanged() { }
    }

    private final Activity activity;
    private final AccountsStore store;
    private final LinearLayout rail, list, controls;
    private final EditText search;
    private final TextView count;
    private final View empty, filterEmpty;
    private final Callbacks callbacks;
    private final Button groupButton, sortButton;
    private final TextWatcher watcher;
    private final CharSequence previousHint;
    private AlertDialog dialog;
    private String group;
    private boolean disposed;

    public AccountRenderer(Activity activity, AccountsStore store, LinearLayout rail,
                           LinearLayout list, EditText search, TextView count,
                           View empty, View filterEmpty, Callbacks callbacks) {
        this.activity = activity;
        this.store = store;
        this.rail = rail;
        this.list = list;
        this.search = search;
        this.count = count;
        this.empty = empty;
        this.filterEmpty = filterEmpty;
        this.callbacks = callbacks;
        previousHint = search.getHint();
        search.setHint(R.string.org_search_hint);
        controls = new LinearLayout(activity);
        controls.setOrientation(LinearLayout.VERTICAL);
        controls.setPadding(dp(12), dp(4), dp(12), 0);
        LinearLayout filters = new LinearLayout(activity);
        groupButton = button("", v -> showGroupFilter());
        sortButton = button("", v -> showSort());
        filters.addView(groupButton, weighted());
        filters.addView(sortButton, weighted());
        controls.addView(filters);
        LinearLayout manage = new LinearLayout(activity);
        manage.addView(button(text(R.string.org_create_group), v -> editGroup(null, null)), weighted());
        manage.addView(button(text(R.string.org_manage_groups), v -> manageGroups()), weighted());
        controls.addView(manage);
        // Existing layout nests accountList directly in a ScrollView. Put controls above it.
        View anchor = list;
        while (anchor.getParent() instanceof ViewGroup && !(anchor.getParent() instanceof LinearLayout)) {
            anchor = (View) anchor.getParent();
        }
        if (anchor.getParent() instanceof LinearLayout) {
            LinearLayout parent = (LinearLayout) anchor.getParent();
            parent.addView(controls, parent.indexOfChild(anchor));
        }
        watcher = new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int n, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int n) { render(); }
            @Override public void afterTextChanged(Editable s) { }
        };
        search.addTextChangedListener(watcher);
        count.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        filterEmpty.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    }

    public void render() {
        if (disposed) return;
        if (group != null && !group.isEmpty() && !store.getGroups().contains(group)) group = null;
        List<Account> shown = selected();
        rail.removeAllViews();
        list.removeAllViews();
        for (Account a : shown) {
            rail.addView(railAvatar(a));
            list.addView(row(a));
        }
        count.setText(activity.getString(R.string.org_count, shown.size(), store.all().size()));
        empty.setVisibility(store.all().isEmpty() ? View.VISIBLE : View.GONE);
        boolean filtering = group != null || !search.getText().toString().trim().isEmpty();
        filterEmpty.setVisibility(filtering && shown.isEmpty() ? View.VISIBLE : View.GONE);
        groupButton.setText(activity.getString(R.string.org_group_filter, groupLabel(group)));
        sortButton.setText(activity.getString(R.string.org_sort, sortLabel(store.getSortMode())));
    }

    private List<Account> selected() {
        return AccountOrdering.select(store.all(), search.getText().toString(), group, store.getSortMode());
    }

    private View railAvatar(Account a) {
        FrameLayout wrap = new FrameLayout(activity);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(48), dp(48));
        lp.gravity = Gravity.CENTER_HORIZONTAL;
        lp.bottomMargin = dp(4);
        wrap.setLayoutParams(lp);
        wrap.setBackgroundResource(a.id == store.getCurrentId() ? R.drawable.bg_rail_active : R.drawable.bg_rail_btn);
        wrap.addView(tile(a), new FrameLayout.LayoutParams(dp(38), dp(38), Gravity.CENTER));
        View dot = new View(activity);
        dot.setBackgroundResource(a.logged ? R.drawable.bg_dot_on : R.drawable.bg_dot_off);
        wrap.addView(dot, new FrameLayout.LayoutParams(dp(10), dp(10), Gravity.BOTTOM | Gravity.END));
        wrap.setContentDescription(description(a));
        wrap.setFocusable(true);
        wrap.setSelected(a.id == store.getCurrentId());
        wrap.setOnClickListener(v -> callbacks.select(a.id));
        wrap.setOnLongClickListener(v -> { showActions(a.id); return true; });
        return wrap;
    }

    private View row(Account a) {
        LinearLayout row = new LinearLayout(activity);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(4), dp(8), dp(4), dp(8));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(4);
        row.setLayoutParams(params);
        row.setBackgroundResource(a.id == store.getCurrentId() ? R.drawable.bg_row_active : R.drawable.bg_row);
        LinearLayout info = new LinearLayout(activity);
        info.setOrientation(LinearLayout.VERTICAL);
        info.setPadding(dp(8), dp(4), dp(4), dp(4));
        info.setMinimumHeight(dp(48));
        TextView name = label(a.name, 14, R.color.text_primary);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        info.addView(name);
        String status = text(a.logged ? R.string.status_logged : R.string.status_not_logged);
        info.addView(label(status, 12, R.color.text_secondary));
        String detail = groupLabel(a.group);
        if (a.pinned) detail = text(R.string.org_pinned) + " · " + detail;
        if (a.tags != null && !a.tags.isEmpty()) detail += " · " + TextUtils.join(", ", a.tags);
        info.addView(label(detail, 12, R.color.text_secondary));
        info.setContentDescription(description(a));
        info.setFocusable(true);
        info.setSelected(a.id == store.getCurrentId());
        info.setOnClickListener(v -> callbacks.select(a.id));
        info.setOnLongClickListener(v -> { showActions(a.id); return true; });
        row.addView(info, weighted());
        if (AccountOrdering.MANUAL.equals(store.getSortMode())) {
            Button handle = button("≡", v -> toast(R.string.org_drag_hint));
            handle.setContentDescription(activity.getString(R.string.org_drag, a.name));
            handle.setOnLongClickListener(v -> {
                List<Long> ids = new ArrayList<>();
                for (Account item : selected()) ids.add(item.id);
                return v.startDragAndDrop(ClipData.newPlainText("account", Long.toString(a.id)),
                        new View.DragShadowBuilder(row), new Drag(a.id, ids), 0);
            });
            row.addView(handle, new LinearLayout.LayoutParams(dp(48), dp(48)));
            row.setOnDragListener((v, event) -> onDrag(row, a.id, event));
        }
        Button actions = button("⋮", v -> showActions(a.id));
        actions.setTextSize(22);
        actions.setContentDescription(activity.getString(R.string.org_actions, a.name));
        row.addView(actions, new LinearLayout.LayoutParams(dp(48), dp(48)));
        return row;
    }

    private boolean onDrag(View row, long targetId, DragEvent event) {
        if (!(event.getLocalState() instanceof Drag) || disposed) return false;
        Drag drag = (Drag) event.getLocalState();
        Account source = store.findById(drag.id), target = store.findById(targetId);
        if (source == null || target == null || source.pinned != target.pinned) return false;
        switch (event.getAction()) {
            case DragEvent.ACTION_DRAG_STARTED:
                return AccountOrdering.MANUAL.equals(store.getSortMode());
            case DragEvent.ACTION_DRAG_ENTERED:
                row.setAlpha(0.65f);
                return true;
            case DragEvent.ACTION_DRAG_EXITED:
            case DragEvent.ACTION_DRAG_ENDED:
                row.setAlpha(1f);
                return true;
            case DragEvent.ACTION_DRAG_LOCATION:
                if (list.getParent() instanceof ScrollView) {
                    ScrollView scroll = (ScrollView) list.getParent();
                    float y = row.getTop() + event.getY() - scroll.getScrollY();
                    if (y < dp(48)) scroll.smoothScrollBy(0, -dp(24));
                    else if (y > scroll.getHeight() - dp(48)) scroll.smoothScrollBy(0, dp(24));
                }
                return true;
            case DragEvent.ACTION_DROP:
                row.setAlpha(1f);
                List<Long> current = partitionIds(source);
                current.retainAll(drag.visibleIds); // filter changes during a drag cannot move newly hidden rows
                long before = targetId;
                if (event.getY() > row.getHeight() / 2f) {
                    int index = current.indexOf(targetId);
                    before = index >= 0 && index + 1 < current.size() ? current.get(index + 1) : -1;
                }
                if (!current.contains(targetId)) return false;
                if (store.moveBefore(drag.id, before, current)) moved();
                return true;
            default: return true;
        }
    }

    private static final class Drag {
        final long id;
        final List<Long> visibleIds;
        Drag(long id, List<Long> visibleIds) { this.id = id; this.visibleIds = visibleIds; }
    }

    public void showActions(long id) {
        if (disposed) return;
        Account a = store.findById(id);
        if (a == null) return;
        List<String> labels = new ArrayList<>();
        List<Runnable> actions = new ArrayList<>();
        addAction(labels, actions, R.string.cd_config, () -> callbacks.configure(id));
        addAction(labels, actions, R.string.org_rename_account, () -> rename(id));
        addAction(labels, actions, a.pinned ? R.string.org_unpin : R.string.org_pin,
                () -> { store.setPinned(id, !a.pinned); render(); });
        addAction(labels, actions, R.string.org_assign_group, () -> assignGroup(id));
        if (AccountOrdering.MANUAL.equals(store.getSortMode())) {
            List<Long> ids = partitionIds(a);
            int index = ids.indexOf(id);
            if (index > 0) addAction(labels, actions, R.string.org_move_up, () -> move(id, -1));
            if (index >= 0 && index + 1 < ids.size()) addAction(labels, actions, R.string.org_move_down, () -> move(id, 1));
        }
        addAction(labels, actions, R.string.org_shortcut, () -> callbacks.shortcut(id));
        addAction(labels, actions, R.string.cd_delete, () -> confirmDelete(id));
        show(new AlertDialog.Builder(activity).setTitle(a.name)
                .setItems(labels.toArray(new String[0]), (d, which) -> actions.get(which).run())
                .setNegativeButton(R.string.btn_cancel, null).create());
    }

    private void addAction(List<String> labels, List<Runnable> actions, int label, Runnable action) {
        labels.add(text(label));
        actions.add(action);
    }

    private List<Long> partitionIds(Account source) {
        List<Long> ids = new ArrayList<>();
        for (Account a : selected()) if (a.pinned == source.pinned) ids.add(a.id);
        return ids;
    }

    private void move(long id, int direction) {
        Account source = store.findById(id);
        if (source == null) return;
        List<Long> ids = partitionIds(source);
        int index = ids.indexOf(id);
        if (index < 0 || index + direction < 0 || index + direction >= ids.size()) return;
        long before = direction < 0 ? ids.get(index - 1) : index + 2 < ids.size() ? ids.get(index + 2) : -1;
        if (store.moveBefore(id, before, ids)) moved();
    }

    private void moved() {
        render();
        count.announceForAccessibility(text(R.string.org_moved));
    }

    private void showSort() {
        String[] modes = {AccountOrdering.MANUAL, AccountOrdering.NAME, AccountOrdering.RECENT};
        String[] labels = {sortLabel(modes[0]), sortLabel(modes[1]), sortLabel(modes[2])};
        int selected = java.util.Arrays.asList(modes).indexOf(store.getSortMode());
        show(new AlertDialog.Builder(activity).setTitle(R.string.org_sort_manual)
                .setSingleChoiceItems(labels, selected, (d, which) -> {
                    store.setSortMode(modes[which]); d.dismiss(); render();
                }).setNegativeButton(R.string.btn_cancel, null).create());
    }

    private void showGroupFilter() {
        List<String> values = new ArrayList<>();
        values.add(null); values.add(""); values.addAll(store.getGroups());
        String[] labels = new String[values.size()];
        for (int i = 0; i < values.size(); i++) labels[i] = groupLabel(values.get(i));
        show(new AlertDialog.Builder(activity).setTitle(R.string.org_all_groups)
                .setSingleChoiceItems(labels, values.indexOf(group), (d, which) -> {
                    group = values.get(which); d.dismiss(); render();
                }).setNegativeButton(R.string.btn_cancel, null).create());
    }

    private void assignGroup(long id) {
        Account a = store.findById(id);
        if (a == null) return;
        List<String> groups = store.getGroups();
        groups.add(0, "");
        List<String> labels = new ArrayList<>();
        for (String value : groups) labels.add(groupLabel(value));
        labels.add(text(R.string.org_create_group));
        show(new AlertDialog.Builder(activity).setTitle(R.string.org_assign_group)
                .setItems(labels.toArray(new String[0]), (d, which) -> {
                    if (which == groups.size()) editGroup(null, id);
                    else { store.assignGroup(id, groups.get(which)); render(); }
                }).setNegativeButton(R.string.btn_cancel, null).create());
    }

    private void manageGroups() {
        List<String> groups = store.getGroups();
        if (groups.isEmpty()) { toast(R.string.org_no_groups); editGroup(null, null); return; }
        show(new AlertDialog.Builder(activity).setTitle(R.string.org_manage_groups)
                .setItems(groups.toArray(new String[0]), (d, which) -> {
                    String value = groups.get(which);
                    show(new AlertDialog.Builder(activity).setTitle(value)
                            .setItems(new String[]{text(R.string.org_rename_group), text(R.string.org_delete_group)},
                                    (inner, action) -> {
                                        if (action == 0) editGroup(value, null);
                                        else confirmDeleteGroup(value);
                                    }).setNegativeButton(R.string.btn_cancel, null).create());
                }).setNegativeButton(R.string.btn_cancel, null).create());
    }

    private void editGroup(String old, Long accountId) {
        editText(old == null ? R.string.org_create_group : R.string.org_rename_group,
                R.string.org_group_name, old == null ? "" : old, 24, R.string.org_invalid_group, value -> {
                    boolean changed = old == null ? store.createGroup(value) : store.renameGroup(old, value);
                    if (!changed) return false;
                    if (old != null && old.equals(group)) group = value;
                    if (accountId != null) store.assignGroup(accountId, value);
                    render();
                    return true;
                });
    }

    private void confirmDeleteGroup(String value) {
        show(new AlertDialog.Builder(activity).setTitle(R.string.org_delete_group)
                .setMessage(activity.getString(R.string.org_delete_group_confirm, value))
                .setPositiveButton(R.string.btn_delete, (d, which) -> { store.deleteGroup(value); render(); })
                .setNegativeButton(R.string.btn_cancel, null).create());
    }

    private void rename(long id) {
        Account a = store.findById(id);
        if (a == null) return;
        editText(R.string.org_rename_account, R.string.rename_hint, a.name, 16, R.string.org_invalid_name, value -> {
            if (store.findById(id) == null) return false;
            store.rename(id, value);
            callbacks.metadataChanged();
            render();
            return true;
        });
    }

    private void confirmDelete(long id) {
        Account a = store.findById(id);
        if (a == null) return;
        show(new AlertDialog.Builder(activity).setTitle(R.string.cd_delete)
                .setMessage(activity.getString(R.string.confirm_delete_fmt, a.name))
                .setPositiveButton(R.string.btn_delete, (d, which) -> {
                    if (store.findById(id) != null) callbacks.delete(id);
                    render();
                }).setNegativeButton(R.string.btn_cancel, null).create());
    }

    private interface SaveText { boolean save(String value); }

    private void editText(int title, int hint, String value, int max, int error, SaveText save) {
        EditText input = new EditText(activity);
        input.setSingleLine(true);
        input.setHint(hint);
        input.setContentDescription(text(hint));
        input.setText(value);
        input.setTextSize(14);
        input.setPadding(dp(24), dp(12), dp(24), dp(12));
        input.setFilters(new InputFilter[]{new InputFilter.LengthFilter(max)});
        input.setImeOptions(EditorInfo.IME_ACTION_DONE);
        AlertDialog edit = new AlertDialog.Builder(activity).setTitle(title).setView(input)
                .setPositiveButton(R.string.btn_ok, null).setNegativeButton(R.string.btn_cancel, null).create();
        show(edit);
        if (!edit.isShowing()) return;
        View.OnClickListener submit = v -> {
            String name = input.getText().toString().trim();
            if (name.isEmpty() || !save.save(name)) input.setError(text(error));
            else edit.dismiss();
        };
        edit.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(submit);
        input.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId != EditorInfo.IME_ACTION_DONE) return false;
            submit.onClick(v); return true;
        });
        input.requestFocus();
        input.selectAll();
    }

    private void show(AlertDialog next) {
        if (disposed || activity.isFinishing() || activity.isDestroyed()) return;
        if (dialog != null) dialog.dismiss();
        dialog = next;
        next.setOnDismissListener(d -> { if (dialog == next) dialog = null; });
        next.show();
    }

    public void dispose() {
        if (disposed) return;
        disposed = true;
        search.removeTextChangedListener(watcher);
        search.setHint(previousHint);
        if (dialog != null) dialog.dismiss();
        dialog = null;
        if (controls.getParent() instanceof ViewGroup) ((ViewGroup) controls.getParent()).removeView(controls);
        rail.removeAllViews();
        list.removeAllViews();
    }

    private String description(Account a) {
        String state = text(a.logged ? R.string.status_logged : R.string.status_not_logged);
        if (a.id == store.getCurrentId()) state += " · " + text(R.string.org_selected);
        if (a.pinned) state += " · " + text(R.string.org_pinned);
        return activity.getString(R.string.org_select, a.name, state);
    }

    private String groupLabel(String value) {
        return value == null ? text(R.string.org_all_groups) : value.isEmpty() ? text(R.string.org_ungrouped) : value;
    }

    private String sortLabel(String mode) {
        return text(AccountOrdering.NAME.equals(mode) ? R.string.org_sort_name
                : AccountOrdering.RECENT.equals(mode) ? R.string.org_sort_recent : R.string.org_sort_manual);
    }

    private TextView tile(Account a) {
        TextView tile = label(a.avatar == null || a.avatar.isEmpty() ? "m" : a.avatar, 20, R.color.blue);
        tile.setGravity(Gravity.CENTER);
        tile.setTypeface(Typeface.create("serif", Typeface.BOLD_ITALIC));
        tile.setBackgroundResource(R.drawable.bg_mtile);
        tile.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        return tile;
    }

    private TextView label(String value, int sp, int color) {
        TextView label = new TextView(activity);
        label.setText(value);
        label.setTextSize(sp);
        label.setTextColor(activity.getColor(color));
        label.setMaxLines(1);
        label.setEllipsize(TextUtils.TruncateAt.END);
        return label;
    }

    private Button button(String value, View.OnClickListener action) {
        Button button = new Button(activity);
        button.setText(value);
        button.setTextSize(12);
        button.setAllCaps(false);
        button.setTextColor(activity.getColor(R.color.text_primary));
        button.setBackgroundTintList(ColorStateList.valueOf(activity.getColor(R.color.btn_gray)));
        button.setMinimumHeight(dp(48));
        button.setMinHeight(dp(48));
        button.setMinWidth(dp(48));
        button.setPadding(dp(4), 0, dp(4), 0);
        button.setFocusable(true);
        button.setOnClickListener(action);
        return button;
    }

    private LinearLayout.LayoutParams weighted() { return new LinearLayout.LayoutParams(0, -2, 1f); }
    private int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
    private String text(int id) { return activity.getString(id); }
    private void toast(int id) { Toast.makeText(activity, id, Toast.LENGTH_SHORT).show(); }
}
