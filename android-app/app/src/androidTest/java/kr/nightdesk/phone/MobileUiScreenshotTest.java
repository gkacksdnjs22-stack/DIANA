package kr.nightdesk.phone;

import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.Espresso.pressBack;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.action.ViewActions.closeSoftKeyboard;
import static androidx.test.espresso.action.ViewActions.replaceText;
import static androidx.test.espresso.action.ViewActions.scrollTo;
import static androidx.test.espresso.action.ViewActions.typeText;
import static androidx.test.espresso.assertion.ViewAssertions.doesNotExist;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.ViewMatchers.isDisplayed;
import static androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom;
import static androidx.test.espresso.matcher.ViewMatchers.withContentDescription;
import static androidx.test.espresso.matcher.ViewMatchers.withTagValue;
import static androidx.test.espresso.matcher.ViewMatchers.withText;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.equalTo;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.TextView;
import android.widget.EditText;
import android.widget.ScrollView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.SdkSuppress;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Real Android views and screenshots, using only inert local demo files and a reserved host. */
@RunWith(AndroidJUnit4.class)
public final class MobileUiScreenshotTest {
    private static final String JOB_ID = "11111111-2222-4333-8444-555555555555";
    private static final String UPLOAD_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    private static final String SEARCH_ID = "cccccccc-dddd-4eee-8fff-111111111111";
    private static final String RAW_RESULT_ID = "dddddddd-eeee-4fff-8111-222222222222";
    private static final String RAW_RESULT_NAME = "모바일_요청_결과.txt";
    private static final String CANDIDATE_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private static final String CANDIDATE_NAME = "거래처_계약서.txt";
    private static final String TITLE = "이번 주 업무 보고서";
    private static final String TEXT_NAME = "주간_업무_정리.txt";
    private static final String APK_NAME = "DIANA-install-check.apk";
    private static final String LATEST_RECEIVED_NAME = "방금_받은_보고서.pdf";
    private static final String PREVIOUS_RECEIVED_NAME = "이전_받은_메모.txt";
    private Context context;
    private ActivityScenario<MainActivity> scenario;

    @Before public void seedLocalOnlyDemo() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        // A fresh test install has no paired session when Application initializes.
        // This reserved host is never a real API; CI also disables emulator Wi-Fi/data.
        context.getSharedPreferences("MainActivity", 0).edit().clear()
            .putBoolean("auto_receive", false)
            .putString("last_sync", "2026-10-23T05:50:00Z").commit();
        context.getSharedPreferences("settings", 0).edit().clear()
            .putString("push_status", "자동 수신 꺼짐").commit();
        JSONObject session = new JSONObject().put("baseUrl", "https://diana-ui.invalid")
            .put("phoneId", "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff")
            .put("phoneToken", "ui-demo-only-no-real-credentials-0000000000000000")
            .put("firebase", new JSONObject().put("enabled", false));
        new SecureStore(context).save(session);
        SyncEngine.recordLatestReceive(context, session, LATEST_RECEIVED_NAME, 1, "2026-10-23T05:50:00Z");

        JSONObject text = artifact(TEXT_NAME, "text/plain", "주요 성과를 확인하고 다음 주 할 일을 정리했습니다.\n".getBytes(StandardCharsets.UTF_8));
        JSONObject apk = artifact(APK_NAME, "application/vnd.android.package-archive", "inert-ui-fixture-never-install".getBytes(StandardCharsets.UTF_8));
        JSONArray artifacts = new JSONArray().put(text).put(apk);
        JSONObject request = new JSONObject().put("subject", TITLE).put("query", TITLE)
            .put("delivery", "download").put("goal", "성과와 개선점을 근거 중심으로 정리해 주세요.");
        JSONObject report = new JSONObject().put("id", JOB_ID).put("kind", "overnight")
            .put("state", "download_ready").put("request", request)
            .put("createdAt", "2026-10-23T05:45:00Z").put("updatedAt", "2026-10-23T05:50:00Z")
            .put("phoneSavedAt", "2026-10-23T05:50:00Z").put("artifacts", artifacts)
            .put("events", new JSONArray().put(new JSONObject().put("at", "2026-10-23T05:50:00Z")
                .put("text", "검토를 마친 결과를 앱에 보관했습니다.")));
        JSONObject upload = new JSONObject().put("id", UPLOAD_ID).put("kind", "upload")
            .put("state", "pc_saved").put("request", new JSONObject().put("filename", "현장_메모.txt").put("bytes", 2048))
            .put("createdAt", "2026-10-23T05:40:00Z").put("updatedAt", "2026-10-23T05:42:00Z")
            .put("pcSavedAt", "2026-10-23T05:42:00Z").put("events", new JSONArray());
        // Normal search jobs from the deployed protocol intentionally have no kind field.
        JSONObject search = new JSONObject().put("id", SEARCH_ID).put("state", "needs_selection").put("mode", "openai")
            .put("request", new JSONObject().put("query", "거래처 계약서 원본을 찾아줘")
                .put("delivery", "download").put("autoSend", false).put("editInstruction", ""))
            .put("createdAt", "2026-10-23T05:43:00Z").put("updatedAt", "2026-10-23T05:44:00Z")
            .put("candidates", new JSONArray().put(new JSONObject().put("id", CANDIDATE_ID)
                .put("filename", CANDIDATE_NAME).put("bytes", 2536).put("score", 0.97)
                .put("modifiedAt", "2026-10-22T03:00:00Z")
                .put("excerpt", "거래처와 체결한 계약의 주요 조건과 납품 일정을 정리한 문서입니다.")))
            .put("events", new JSONArray().put(new JSONObject().put("at", "2026-10-23T05:44:00Z")
                .put("text", "받을 문서를 선택해 주세요.")));
        JSONObject localResult = artifact(RAW_RESULT_ID, RAW_RESULT_NAME, "text/plain",
            "일반 검색 결과의 단일 파일 명세를 앱에서 다시 열 수 있습니다.\n".getBytes(StandardCharsets.UTF_8));
        // A fresh /api/jobs poll returns only artifact, without normalized artifacts[], id or MIME.
        // Deliberately omit this job from saved-jobs.json so that a history fallback cannot hide the bug.
        JSONObject rawResult = new JSONObject().put("id", RAW_RESULT_ID).put("state", "download_ready")
            .put("request", new JSONObject().put("query", "찾은 문서 결과 확인")
                .put("delivery", "download").put("autoSend", false).put("editInstruction", ""))
            .put("artifact", new JSONObject().put("filename", RAW_RESULT_NAME)
                .put("sha256", localResult.getString("sha256")).put("bytes", localResult.getLong("bytes")))
            .put("createdAt", "2026-10-23T05:41:00Z").put("updatedAt", "2026-10-23T05:46:00Z")
            .put("events", new JSONArray());
        SyncEngine.cache(context, new JSONObject().put("jobs", new JSONArray().put(report).put(upload).put(search).put(rawResult)));
        JSONObject saved = new JSONObject().put("id", JOB_ID).put("title", TITLE)
            .put("createdAt", "2026-10-23T05:45:00Z").put("phoneSavedAt", "2026-10-23T05:50:00Z")
            .put("artifacts", artifacts);
        try (FileOutputStream output = new FileOutputStream(new File(context.getFilesDir(), "saved-jobs.json"))) {
            output.write(new JSONObject().put("jobs", new JSONArray().put(saved)).toString().getBytes(StandardCharsets.UTF_8));
        }
        scenario = ActivityScenario.launch(new Intent(context, MainActivity.class));
    }

    @After public void clearFakeSession() {
        if (scenario != null) scenario.close();
        if (context != null) {
            new SecureStore(context).clear();
            context.getSharedPreferences("MainActivity", 0).edit().clear().putBoolean("auto_receive", false).commit();
            context.getSharedPreferences("settings", 0).edit().clear().commit();
        }
    }

    @Test public void homeMenuCommandDraftAndTitleOnlyRecentDetailsSurviveNavigation() throws Exception {
        assertHomeOnlyControls();
        screenshot("01-home");

        navigate("files");
        onView(withText(containsString(TEXT_NAME))).check(matches(isDisplayed()));
        screenshot("02-files");

        navigate("pc_sync");
        onView(withTagValue(equalTo("pc_query"))).check(matches(isAssignableFrom(EditText.class)))
            .perform(scrollTo(), replaceText("지난 분기 보고서를 찾아줘"), closeSoftKeyboard());
        onView(withTagValue(equalTo("pc_edit_instruction"))).check(matches(isAssignableFrom(EditText.class)))
            .perform(scrollTo(), replaceText("핵심 성과와 개선점을 구분해 정리해줘"), closeSoftKeyboard());
        onView(withTagValue(equalTo("pc_submit"))).check((view, error) -> {
            if (error != null) throw error;
            assertTrue("PC requests need an explicit submit action", view.isClickable());
        });
        // Submit is intentionally never tapped: these tests do not create remote PC requests.
        scrollPageToTop();
        screenshot("03-pc-request");

        navigate("recent");
        onView(withTagValue(equalTo("recent_job_" + JOB_ID))).check((view, error) -> {
            if (error != null) throw error;
            assertTrue("The recent row must show the job title", containsText(view, TITLE));
            assertFalse("Recent rows must not expand artifact filenames inline", containsText(view, TEXT_NAME));
            assertFalse("Recent rows must not expand install actions inline", containsText(view, APK_NAME));
        });
        onView(withText(containsString(TEXT_NAME))).check(doesNotExist());
        onView(withText(containsString(APK_NAME))).check(doesNotExist());
        screenshot("04-recent");

        onView(withTagValue(equalTo("recent_job_" + JOB_ID))).perform(click());
        onView(withTagValue(equalTo("job_detail"))).check((view, error) -> {
            if (error != null) throw error;
            assertTrue("Details must retain the selected title", containsText(view, TITLE));
            assertTrue("Details must expose the selected job's files", containsText(view, TEXT_NAME));
        });
        onView(withContentDescription("돌아가기")).check(matches(isDisplayed()));
        screenshot("05-details");

        pressBack();
        assertScreen("recent");
        onView(withTagValue(equalTo("job_detail"))).check(doesNotExist());
        onView(withTagValue(equalTo("recent_job_" + JOB_ID))).check(matches(isDisplayed())).perform(click());
        assertBrandVisible();
        onView(withTagValue(equalTo("job_detail"))).check(matches(isDisplayed()));
        onView(withContentDescription("돌아가기")).perform(click());
        assertScreen("recent");
        onView(withTagValue(equalTo("job_detail"))).check(doesNotExist());
        onView(withTagValue(equalTo("recent_job_" + JOB_ID))).check(matches(isDisplayed()));

        onView(withText(CANDIDATE_NAME)).check(doesNotExist());
        onView(withTagValue(equalTo("recent_job_" + SEARCH_ID))).perform(scrollTo(), click());
        onView(withTagValue(equalTo("job_detail"))).check(matches(isDisplayed()));
        onView(withTagValue(equalTo("select_candidate_" + CANDIDATE_ID))).perform(scrollTo())
            .check(matches(isDisplayed())).check((view, error) -> {
                if (error != null) throw error;
                assertTrue("A normal search candidate must offer a selectable action", view.isClickable() && view.isEnabled());
            });
        onView(withText(CANDIDATE_NAME)).check(matches(isDisplayed()));
        // Candidate selection would contact the API; this offline test only validates the native action.
        pressBack();
        assertScreen("recent");
        onView(withTagValue(equalTo("job_detail"))).check(doesNotExist());
        onView(withTagValue(equalTo("recent_job_" + SEARCH_ID))).check(matches(isDisplayed()));

        onView(withText(RAW_RESULT_NAME)).check(doesNotExist());
        onView(withTagValue(equalTo("recent_job_" + RAW_RESULT_ID))).perform(scrollTo(), click());
        onView(withTagValue(equalTo("job_detail"))).check((view, error) -> {
            if (error != null) throw error;
            assertTrue("A raw single-artifact response must retain its file in details", containsText(view, RAW_RESULT_NAME));
        });
        onView(withText("파일 열기")).perform(scrollTo()).check(matches(isDisplayed())).check((view, error) -> {
            if (error != null) throw error;
            assertTrue("A verified local single artifact must remain available to open", view.isEnabled() && view.isClickable());
        });
        onView(withText(RAW_RESULT_NAME)).check(matches(isDisplayed()));
        // Do not launch an external viewer; local availability is the regression under test.
        pressBack();
        assertScreen("recent");
        onView(withTagValue(equalTo("job_detail"))).check(doesNotExist());
        onView(withTagValue(equalTo("recent_job_" + RAW_RESULT_ID))).check(matches(isDisplayed()));

        navigate("settings");
        scenario.recreate();
        assertScreen("settings");
        screenshot("06-settings");

        openMenu();
        screenshot("07-menu", true);
        pressBack();
        onView(withTagValue(equalTo("app_drawer"))).check(doesNotExist());
        assertScreen("settings");

        navigate("pc_sync");
        assertCommandDraft();
        scenario.recreate();
        assertScreen("pc_sync");
        assertCommandDraft();
        navigate("home");
        assertHomeOnlyControls();
    }

    @Test @SdkSuppress(minSdkVersion = 30)
    public void realKeyboardKeepsFocusedRequestFieldsVisibleAndRetainsTypedDraft() throws Exception {
        String previousSetting = shell("settings get secure show_ime_with_hard_keyboard").trim();
        shell("settings put secure show_ime_with_hard_keyboard 1");
        try {
            navigate("pc_sync");
            onView(withTagValue(equalTo("pc_query"))).perform(scrollTo(), click());
            awaitImeVisibility(true);
            assertFocusedFieldAboveIme("pc_query");
            onView(withTagValue(equalTo("pc_query"))).perform(typeText("quarterly report"));
            assertFocusedFieldAboveIme("pc_query");
            onView(withTagValue(equalTo("pc_query"))).check(matches(withText("quarterly report")))
                .perform(closeSoftKeyboard());
            awaitImeVisibility(false);

            onView(withTagValue(equalTo("pc_edit_instruction"))).perform(scrollTo(), click());
            awaitImeVisibility(true);
            assertFocusedFieldAboveIme("pc_edit_instruction");
            onView(withTagValue(equalTo("pc_edit_instruction"))).perform(typeText("summarize the key changes"));
            assertFocusedFieldAboveIme("pc_edit_instruction");
            onView(withTagValue(equalTo("pc_edit_instruction"))).check(matches(withText("summarize the key changes")));
            screenshot("08-keyboard");
            assertFocusedFieldAboveIme("pc_edit_instruction");
            onView(withTagValue(equalTo("pc_edit_instruction"))).perform(closeSoftKeyboard());
            awaitImeVisibility(false);

            navigate("home");
            navigate("pc_sync");
            assertKeyboardDraft();
            scenario.recreate();
            assertScreen("pc_sync");
            assertKeyboardDraft();
            // No submit action is tapped: typing and keyboard changes stay entirely local.
        } finally {
            scenario.onActivity(activity -> {
                if (activity.getWindow().getInsetsController() != null)
                    activity.getWindow().getInsetsController().hide(WindowInsets.Type.ime());
            });
            shell(previousSetting.matches("[01]")
                ? "settings put secure show_ime_with_hard_keyboard " + previousSetting
                : "settings delete secure show_ime_with_hard_keyboard");
        }
    }

    @Test public void homeShowsOnlyLatestReceiveAndKeepsItBoundToTheCurrentConnection() throws Exception {
        assertHomeOnlyControls();
        awaitHomeReceiveLog(LATEST_RECEIVED_NAME);

        context.getSharedPreferences("MainActivity", 0).edit().remove("latest_receive_v1").commit();
        awaitHomeReceiveLog(null);
        JSONObject session = new SecureStore(context).load();
        SyncEngine.recordLatestReceive(context, session, PREVIOUS_RECEIVED_NAME, 2, "2026-10-23T05:49:00Z");
        awaitHomeReceiveLog(PREVIOUS_RECEIVED_NAME);
        SyncEngine.recordLatestReceive(context, session, LATEST_RECEIVED_NAME, 1, "2026-10-23T05:50:00Z");
        awaitHomeReceiveLog(LATEST_RECEIVED_NAME);
        onView(withTagValue(equalTo("home_receive_log"))).check((view, error) -> {
            if (error != null) throw error;
            assertFalse("An earlier receipt must not remain in the latest-only row", containsText(view, PREVIOUS_RECEIVED_NAME));
        });

        scenario.recreate();
        assertHomeOnlyControls();
        awaitHomeReceiveLog(LATEST_RECEIVED_NAME);
        navigate("files");
        navigate("home");
        awaitHomeReceiveLog(LATEST_RECEIVED_NAME);

        JSONObject differentConnection = new JSONObject(session.toString())
            .put("phoneId", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
        new SecureStore(context).save(differentConnection);
        scenario.recreate();
        assertHomeOnlyControls();
        awaitHomeReceiveLog(null);
    }

    private void awaitHomeReceiveLog(String filename) {
        long deadline = SystemClock.uptimeMillis() + 5000;
        while (SystemClock.uptimeMillis() < deadline) {
            AtomicReference<Boolean> ready = new AtomicReference<>(false);
            scenario.onActivity(activity -> {
                View decor = activity.getWindow().getDecorView();
                View log = decor.findViewWithTag("home_receive_log");
                int count = countTag(decor, "home_receive_log");
                ready.set(filename == null ? count == 0 : count == 1 && log != null && containsText(log, filename));
            });
            if (ready.get()) {
                if (filename == null) onView(withTagValue(equalTo("home_receive_log"))).check(doesNotExist());
                else onView(withTagValue(equalTo("home_receive_log"))).check(matches(isDisplayed()));
                return;
            }
            SystemClock.sleep(50);
        }
        throw new AssertionError("Home must show exactly one newest receive log, or none when empty: " + filename);
    }

    private static int countTag(View view, String tag) {
        int count = tag.equals(view.getTag()) ? 1 : 0;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) count += countTag(group.getChildAt(index), tag);
        }
        return count;
    }

    private void assertKeyboardDraft() {
        onView(withTagValue(equalTo("pc_query"))).check(matches(withText("quarterly report")));
        onView(withTagValue(equalTo("pc_edit_instruction"))).check(matches(withText("summarize the key changes")));
    }

    private void awaitImeVisibility(boolean expected) {
        long deadline = SystemClock.uptimeMillis() + 5000;
        while (SystemClock.uptimeMillis() < deadline) {
            AtomicReference<Boolean> visible = new AtomicReference<>(false);
            scenario.onActivity(activity -> {
                WindowInsets insets = activity.getWindow().getDecorView().getRootWindowInsets();
                visible.set(insets != null && insets.isVisible(WindowInsets.Type.ime())
                    && insets.getInsets(WindowInsets.Type.ime()).bottom > 0);
            });
            if (visible.get() == expected) return;
            SystemClock.sleep(50);
        }
        throw new AssertionError("The real Android IME did not become " + (expected ? "visible" : "hidden"));
    }

    private void assertFocusedFieldAboveIme(String tag) {
        long deadline = SystemClock.uptimeMillis() + 5000;
        ImeGeometry last = null;
        int stable = 0, previousBottom = -1;
        while (SystemClock.uptimeMillis() < deadline) {
            last = imeGeometry(tag);
            stable = last.imeBottom == previousBottom && last.fullyVisible() ? stable + 1 : 0;
            previousBottom = last.imeBottom;
            if (stable >= 3) return;
            SystemClock.sleep(50);
        }
        throw new AssertionError("Focused input must remain fully above the real IME: " + tag + " " + last);
    }

    private ImeGeometry imeGeometry(String tag) {
        AtomicReference<ImeGeometry> result = new AtomicReference<>();
        scenario.onActivity(activity -> {
            assertTrue("Document windows must retain screenshot protection",
                (activity.getWindow().getAttributes().flags & android.view.WindowManager.LayoutParams.FLAG_SECURE) != 0);
            View decor = activity.getWindow().getDecorView();
            EditText field = decor.findViewWithTag(tag);
            assertNotNull("The focused request field must exist", field);
            WindowInsets insets = decor.getRootWindowInsets();
            int imeBottom = insets == null ? 0 : insets.getInsets(WindowInsets.Type.ime()).bottom;
            int imeTop = activity.getWindowManager().getCurrentWindowMetrics().getBounds().bottom - imeBottom;
            int[] position = new int[2]; field.getLocationOnScreen(position);
            Rect full = new Rect(position[0], position[1], position[0] + field.getWidth(), position[1] + field.getHeight());
            Rect visible = new Rect(); boolean shown = field.getGlobalVisibleRect(visible);
            Rect caret = new Rect(full);
            if (field.getLayout() != null) {
                int line = field.getLayout().getLineForOffset(Math.max(0, field.getSelectionEnd()));
                caret.top = position[1] + field.getTotalPaddingTop() + field.getLayout().getLineTop(line) - field.getScrollY();
                caret.bottom = position[1] + field.getTotalPaddingTop() + field.getLayout().getLineBottom(line) - field.getScrollY();
            }
            ScrollView page = findScroll(decor);
            int viewport = page == null ? 0 : page.getHeight() - page.getPaddingTop() - page.getPaddingBottom();
            result.set(new ImeGeometry(full, visible, caret, viewport, imeTop, imeBottom,
                shown && field.hasFocus() && insets != null && insets.isVisible(WindowInsets.Type.ime())));
        });
        return result.get();
    }

    private static final class ImeGeometry {
        final Rect full, visible, caret;
        final int viewport, imeTop, imeBottom;
        final boolean focusedAndShown;
        ImeGeometry(Rect full, Rect visible, Rect caret, int viewport, int imeTop, int imeBottom, boolean focusedAndShown) {
            this.full = full; this.visible = visible; this.caret = caret; this.viewport = viewport;
            this.imeTop = imeTop; this.imeBottom = imeBottom; this.focusedAndShown = focusedAndShown;
        }
        boolean fullyVisible() {
            if (!focusedAndShown || imeBottom <= 0 || viewport <= 0 || visible.isEmpty()) return false;
            Rect expected = full.height() <= viewport ? full : caret;
            return expected.bottom <= imeTop + 2 && visible.bottom <= imeTop + 2
                && visible.top <= expected.top + 2 && visible.bottom >= expected.bottom - 2
                && visible.left <= expected.left + 2 && visible.right >= expected.right - 2;
        }
        @Override public String toString() {
            return "full=" + full + ", visible=" + visible + ", caret=" + caret
                + ", viewport=" + viewport + ", imeTop=" + imeTop + ", imeBottom=" + imeBottom
                + ", focused=" + focusedAndShown;
        }
    }

    private static String shell(String command) throws Exception {
        ParcelFileDescriptor descriptor = InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand(command);
        try (FileInputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024]; int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private JSONObject artifact(String filename, String mime, byte[] bytes) throws Exception {
        return artifact(JOB_ID, filename, mime, bytes);
    }

    private JSONObject artifact(String jobId, String filename, String mime, byte[] bytes) throws Exception {
        String sha = FileSafety.hex(MessageDigest.getInstance("SHA-256").digest(bytes));
        JSONObject artifact = new JSONObject().put("id", sha).put("sha256", sha).put("filename", filename)
            .put("mime", mime).put("bytes", bytes.length);
        File local = FileSafety.artifact(context.getFilesDir(), jobId, sha, filename);
        assertTrue(local.getParentFile().isDirectory() || local.getParentFile().mkdirs());
        try (FileOutputStream output = new FileOutputStream(local)) { output.write(bytes); }
        return artifact;
    }

    private void assertScreen(String route) {
        assertBrandVisible();
        onView(withTagValue(equalTo("menu_toggle"))).check(matches(isDisplayed()));
        onView(withTagValue(equalTo("screen_" + route))).check(matches(isDisplayed()));
    }

    private void assertHomeOnlyControls() {
        assertScreen("home");
        onView(withTagValue(equalTo("home_sync"))).check(matches(isDisplayed()));
        onView(withTagValue(equalTo("home_folder"))).check(matches(isDisplayed()));
        onView(withText(containsString(TEXT_NAME))).check(doesNotExist());
        onView(withText(containsString(APK_NAME))).check(doesNotExist());
        onView(withTagValue(equalTo("recent_job_" + JOB_ID))).check(doesNotExist());
    }

    private void openMenu() {
        onView(withTagValue(equalTo("menu_toggle"))).perform(click());
        onView(withTagValue(equalTo("app_drawer"))).check(matches(isDisplayed()));
        for (String route : new String[]{"home", "files", "pc_sync", "recent", "settings"})
            onView(withTagValue(equalTo("menu_" + route))).check(matches(isDisplayed()));
    }

    private void navigate(String route) {
        openMenu();
        onView(withTagValue(equalTo("menu_" + route))).perform(click());
        onView(withTagValue(equalTo("app_drawer"))).check(doesNotExist());
        assertScreen(route);
    }

    private void assertCommandDraft() {
        onView(withTagValue(equalTo("pc_query"))).check(matches(withText("지난 분기 보고서를 찾아줘")));
        onView(withTagValue(equalTo("pc_edit_instruction"))).check(matches(withText("핵심 성과와 개선점을 구분해 정리해줘")));
    }

    private void scrollPageToTop() {
        scenario.onActivity(activity -> {
            ScrollView page = findScroll(activity.getWindow().getDecorView());
            assertNotNull("A long page must remain scrollable", page);
            if (page.findViewWithTag("pc_chat_composer") != null) {
                View focused = activity.getCurrentFocus();
                if (focused != null) focused.clearFocus();
                page.setFocusableInTouchMode(true);
                page.requestFocus();
            }
            page.scrollTo(0, 0);
        });
    }

    private static ScrollView findScroll(View view) {
        if (view instanceof ScrollView) return (ScrollView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                ScrollView result = findScroll(group.getChildAt(index));
                if (result != null) return result;
            }
        }
        return null;
    }

    private void assertBrandVisible() {
        onView(withText("DIANA")).check(matches(isDisplayed()));
    }

    private static boolean containsText(View view, String expected) {
        if (view instanceof TextView && ((TextView) view).getText().toString().contains(expected)) return true;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++)
                if (containsText(group.getChildAt(index), expected)) return true;
        }
        return false;
    }

    private void screenshot(String name) throws Exception { screenshot(name, false); }

    private void screenshot(String name, boolean menuOpen) throws Exception {
        if (menuOpen) assertBrandVisibleBehindMenu(); else assertBrandVisible();
        // Espresso's idle state can precede presentation of a newly replaced view tree.
        // Wait on the test thread while the decor presents two actual animation frames.
        CountDownLatch presented = new CountDownLatch(1);
        scenario.onActivity(activity -> {
            View decor = activity.getWindow().getDecorView();
            decor.postOnAnimation(() -> decor.postOnAnimation(presented::countDown));
        });
        assertTrue("The activity must present two frames before capture", presented.await(5, TimeUnit.SECONDS));
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        if (menuOpen) assertBrandVisibleBehindMenu(); else assertBrandVisible();
        // System captures now redact the secure app surface; layout is checked through views above.
        Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull("The emulator must provide a real screenshot", bitmap);
        assertTrue("A phone screenshot must have a useful resolution", bitmap.getWidth() >= 600 && bitmap.getHeight() >= 1000);
        File directory = new File(context.getExternalFilesDir(null), "ui-screenshots");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        String prefix = InstrumentationRegistry.getArguments().getString("screenshotPrefix", "phone");
        assertTrue("Screenshot names must remain local filenames", prefix.matches("[a-z0-9-]+"));
        try (FileOutputStream output = new FileOutputStream(new File(directory, prefix + "-" + name + ".png"))) {
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output));
        } finally { bitmap.recycle(); }
    }

    private void assertBrandVisibleBehindMenu() {
        // Espresso correctly selects the focused popup root while the menu is open.
        // The fixed Activity header is checked directly on its UI thread instead.
        scenario.onActivity(activity -> {
            TextView brand = exactText(activity.getWindow().getDecorView(), "DIANA");
            assertNotNull("The fixed Activity header must retain DIANA", brand);
            assertTrue("The brand must remain onscreen behind the anchored menu",
                brand.isShown() && brand.getGlobalVisibleRect(new Rect()));
        });
    }

    private static TextView exactText(View view, String expected) {
        if (view instanceof TextView && expected.contentEquals(((TextView) view).getText())) return (TextView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                TextView result = exactText(group.getChildAt(index), expected);
                if (result != null) return result;
            }
        }
        return null;
    }
}
