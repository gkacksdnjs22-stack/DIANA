package kr.nightdesk.phone;

import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.assertion.ViewAssertions.doesNotExist;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.ViewMatchers.isDisplayed;
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
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Real Android views and screenshots, using only inert local demo files and a reserved host. */
@RunWith(AndroidJUnit4.class)
public final class MobileUiScreenshotTest {
    private static final String JOB_ID = "11111111-2222-4333-8444-555555555555";
    private static final String UPLOAD_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    private static final String TITLE = "이번 주 업무 보고서";
    private static final String TEXT_NAME = "주간_업무_정리.txt";
    private static final String APK_NAME = "DIANA-install-check.apk";
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
        SyncEngine.cache(context, new JSONObject().put("jobs", new JSONArray().put(report).put(upload)));
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

    @Test public void fourPagesAndTitleOnlyRecentRowsOpenDetailsAndReturn() throws Exception {
        assertAllNavigationVisible();
        onView(withText("내 저장파일")).check(matches(isDisplayed()));
        screenshot("01-files");

        onView(withTagValue(equalTo("nav_send"))).perform(click());
        assertAllNavigationVisible();
        screenshot("02-send");

        onView(withTagValue(equalTo("nav_recent"))).perform(click());
        assertAllNavigationVisible();
        onView(withTagValue(equalTo("recent_job_" + JOB_ID))).check((view, error) -> {
            if (error != null) throw error;
            assertTrue("The recent row must show the job title", containsText(view, TITLE));
            assertFalse("Recent rows must not expand artifact filenames inline", containsText(view, TEXT_NAME));
            assertFalse("Recent rows must not expand install actions inline", containsText(view, APK_NAME));
        });
        onView(withText(containsString(TEXT_NAME))).check(doesNotExist());
        onView(withText(containsString(APK_NAME))).check(doesNotExist());
        screenshot("03-recent");

        onView(withTagValue(equalTo("recent_job_" + JOB_ID))).perform(click());
        onView(withTagValue(equalTo("job_detail"))).check((view, error) -> {
            if (error != null) throw error;
            assertTrue("Details must retain the selected title", containsText(view, TITLE));
            assertTrue("Details must expose the selected job's files", containsText(view, TEXT_NAME));
        });
        onView(withContentDescription("돌아가기")).check(matches(isDisplayed()));
        screenshot("04-details");
        onView(withContentDescription("돌아가기")).perform(click());
        onView(withTagValue(equalTo("job_detail"))).check(doesNotExist());
        onView(withTagValue(equalTo("recent_job_" + JOB_ID))).check(matches(isDisplayed()));
        screenshot("05-recent-back");

        onView(withTagValue(equalTo("nav_settings"))).perform(click());
        assertAllNavigationVisible();
        screenshot("06-settings");

        onView(withTagValue(equalTo("nav_files"))).perform(click());
        onView(withText("내 저장파일")).check(matches(isDisplayed()));
        assertAllNavigationVisible();
        screenshot("07-files-return");
    }

    private JSONObject artifact(String filename, String mime, byte[] bytes) throws Exception {
        String sha = FileSafety.hex(MessageDigest.getInstance("SHA-256").digest(bytes));
        JSONObject artifact = new JSONObject().put("id", sha).put("sha256", sha).put("filename", filename)
            .put("mime", mime).put("bytes", bytes.length);
        File local = FileSafety.artifact(context.getFilesDir(), JOB_ID, sha, filename);
        assertTrue(local.getParentFile().isDirectory() || local.getParentFile().mkdirs());
        try (FileOutputStream output = new FileOutputStream(local)) { output.write(bytes); }
        return artifact;
    }

    private void assertAllNavigationVisible() {
        for (String tag : new String[]{"nav_files", "nav_send", "nav_recent", "nav_settings"})
            onView(withTagValue(equalTo(tag))).check(matches(isDisplayed()));
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

    private void screenshot(String name) throws Exception {
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
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
}
