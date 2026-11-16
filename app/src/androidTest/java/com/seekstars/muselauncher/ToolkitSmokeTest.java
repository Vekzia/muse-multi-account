package com.seekstars.muselauncher;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import java.io.File;
import java.io.FileOutputStream;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.webkit.WebViewFeature;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.Espresso.pressBack;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.ViewMatchers.*;
import static org.hamcrest.Matchers.allOf;
import static org.junit.Assert.*;

/** Local fixture UI smoke: no external account or network login is required. */
@RunWith(AndroidJUnit4.class)
public class ToolkitSmokeTest {
    private Context context;

    @Before public void clearLocalFixture() {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("accounts", Context.MODE_PRIVATE).edit().clear().commit();
        context.getSharedPreferences("quick_access", Context.MODE_PRIVATE).edit().clear().commit();
        context.stopService(new Intent(context, FloatingSwitchService.class));
    }

    private void screenshot(String name) {
        Bitmap image = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull(image);
        File directory = new File(context.getExternalFilesDir(null), "smoke");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        try (FileOutputStream output = new FileOutputStream(new File(directory, name + ".png"))) {
            assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, output));
        } catch (Exception failure) { throw new AssertionError(failure); }
        finally { image.recycle(); }
    }

    @Test public void toolsAndOrganizationMenusWorkWithEmptyAccounts() {
        // This fails explicitly on a stale WebView image instead of silently skipping the main UI.
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                assertTrue("CI image needs MULTI_PROFILE WebView", WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)));
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            onView(withId(R.id.btnRailTools)).perform(click());
            onView(withText("广告与统计域名拦截")).perform(click());
            onView(withText(R.string.pt_blocking_title)).check(matches(isDisplayed()));
            onView(withText(R.string.pt_blocking_enabled)).check(matches(isNotChecked()));
            screenshot("blocking");
            onView(withText(android.R.string.cancel)).perform(click());
            onView(withId(R.id.btnRailExpand)).perform(click());
            onView(withText("分组：全部分组")).check(matches(isDisplayed()));
            screenshot("drawer");
            onView(withText("排序：手动")).perform(click());
            onView(allOf(withText(R.string.org_sort_name), isDisplayed())).perform(click());
            assertEquals(AccountOrdering.NAME, new AccountsStore(context).getSortMode());
            pressBack();
            onView(withId(R.id.btnRailTools)).perform(click());
            onView(withText("悬浮球与通知快切")).perform(click());
            onView(withId(R.id.qa_notification)).check(matches(isNotChecked()));
            onView(withId(R.id.qa_overlay)).check(matches(isNotChecked()));
            screenshot("quick-access");
            onView(withId(R.id.qa_close)).perform(click());
        }
    }

    @Test public void downloadHistoryRendersEmptyState() {
        try (ActivityScenario<DownloadsActivity> scenario = ActivityScenario.launch(DownloadsActivity.class)) {
            onView(withText(R.string.pt_downloads_title)).check(matches(isDisplayed()));
            onView(withText(R.string.pt_refresh)).check(matches(isDisplayed()));
        }
    }

    @Test public void failedSwitchShowsRequestedAccountAndOpensItsConfiguration() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                assertTrue("CI image needs MULTI_PROFILE WebView",
                        WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)));
        AccountsStore store = new AccountsStore(context);
        Account first = store.addDefault();
        store.rename(first.id, "Smoke Current A");
        Account second = store.addDefault();
        store.rename(second.id, "Smoke Failed B");
        // Embedded proxy credentials are rejected before any WebView/network load begins.
        second.proxy = "http://fixture:fixture@127.0.0.1:9";
        store.save();
        store.setCurrent(first.id);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(
                AccountShortcuts.switchIntent(context, second.id))) {
            onView(withId(R.id.errorOverlay)).check(matches(isDisplayed()));
            onView(withId(R.id.errorTitle)).check(matches(withText("Smoke Failed B · 页面加载失败")));
            assertEquals(first.id, new AccountsStore(context).getCurrentId());
            onView(withText("账号配置")).perform(click());
            onView(withId(R.id.cfgName)).check(matches(withText("Smoke Failed B")));
            onView(withId(R.id.cfgBack)).perform(click());
        }
    }

    @Test public void accountPickerRendersOnlyExistingFixtureAccounts() {
        AccountsStore store = new AccountsStore(context);
        Account first = store.addDefault();
        store.rename(first.id, "Smoke Alpha");
        Account second = store.addDefault();
        store.rename(second.id, "Smoke Beta");
        try (ActivityScenario<AccountPickerActivity> scenario = ActivityScenario.launch(AccountPickerActivity.class)) {
            onView(withText("Smoke Alpha")).check(matches(isDisplayed()));
            onView(withText("Smoke Beta")).check(matches(isDisplayed()));
            screenshot("picker");
        }
    }
}
