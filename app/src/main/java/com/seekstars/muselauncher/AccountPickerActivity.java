package com.seekstars.muselauncher;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/** Small account chooser used by the notification and overlay entry points. */
public class AccountPickerActivity extends Activity {
    private AccountsStore store;
    private LinearLayout accountList;
    private TextView empty;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.qa_activity_picker);
        store = new AccountsStore(this);
        accountList = findViewById(R.id.qa_picker_accounts);
        empty = findViewById(R.id.qa_picker_empty);
        findViewById(R.id.qa_picker_close).setOnClickListener(v -> finish());
        findViewById(R.id.qa_picker_open_app).setOnClickListener(v -> openMain(null));
        render();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (store != null) {
            store.reload();
            render();
        }
    }

    private void render() {
        accountList.removeAllViews();
        if (store.all().isEmpty()) {
            empty.setText(R.string.qa_no_accounts);
            empty.setVisibility(View.VISIBLE);
            return;
        }
        empty.setVisibility(View.GONE);
        for (Account account : store.all()) {
            Button item = new Button(this);
            item.setAllCaps(false);
            item.setMinHeight(dp(48));
            item.setText(AccountShortcuts.displayName(this, account));
            item.setTextSize(14);
            item.setMaxLines(2);
            item.setEllipsize(android.text.TextUtils.TruncateAt.END);
            item.setContentDescription(getString(R.string.qa_switch_account, item.getText()));
            item.setOnClickListener(v -> openMain(account));
            accountList.addView(item, new LinearLayout.LayoutParams(-1, dp(56)));
        }
    }

    private void openMain(Account account) {
        store.reload();
        if (account != null && store.findById(account.id) == null) {
            Toast.makeText(this, R.string.qa_account_missing, Toast.LENGTH_LONG).show();
            render();
            return;
        }
        Intent intent;
        if (account == null) {
            intent = new Intent(this, MainActivity.class)
                    .setAction(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LAUNCHER);
        } else {
            intent = AccountShortcuts.switchIntent(this, account.id);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        try {
            startActivity(intent);
            finish();
        } catch (RuntimeException ignored) {
            Toast.makeText(this, R.string.qa_entry_failed, Toast.LENGTH_LONG).show();
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
