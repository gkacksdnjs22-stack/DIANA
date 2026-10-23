package kr.nightdesk.phone;

import org.junit.Test;
import static org.junit.Assert.*;

public class RecentReceiveTest {
    private static final String FIRST = "2026-10-23T06:00:01Z";
    private static final String SECOND = "2026-10-23T06:00:03Z";

    @Test public void cachedFilesAndFolderOnlyCopiesDoNotReplaceThePreviousReceive() throws Exception {
        RecentReceive.Event previous = new RecentReceive.Event("이전_받은_메모.txt", 1, FIRST);
        RecentReceive.Batch noNewFiles = new RecentReceive.Batch();
        assertNull(noNewFiles.afterTransfer(false, "캐시된_보고서.pdf", SECOND));
        assertNull(noNewFiles.afterTransfer(false, "폴더만_복사한_사진.jpg", SECOND));
        assertEquals(0, noNewFiles.count());
        assertEquals("이전_받은_메모.txt", previous.filename);
        assertEquals(FIRST, previous.receivedAt);
    }
    @Test public void partialJobCountsOnlyVerifiedNewFilesAndLaterReceiptRetryAddsNothing() throws Exception {
        RecentReceive.Batch partial = new RecentReceive.Batch();
        assertNull(partial.afterTransfer(false, "기존_슬라이드.pptx", FIRST));
        RecentReceive.Event success = partial.afterTransfer(true, "새_보고서.pdf", FIRST);
        // A failed download never returns true; later folder/ACK failures cannot undo
        // the already verified private file or manufacture another receive event.
        assertNull(partial.afterTransfer(false, "다운로드_실패.txt", SECOND));
        assertEquals(1, partial.count());
        assertEquals(1, success.count);
        RecentReceive.Batch retry = new RecentReceive.Batch();
        assertNull(retry.afterTransfer(false, "새_보고서.pdf", SECOND));
        assertNull(retry.afterTransfer(false, "기존_슬라이드.pptx", SECOND));
        assertEquals(0, retry.count());
        assertEquals("새_보고서.pdf", success.filename);
    }
    @Test public void oneBatchAcrossJobsKeepsFirstNewFilenameAndLatestTransferTime() throws Exception {
        RecentReceive.Batch batch = new RecentReceive.Batch();
        RecentReceive.Event first = batch.afterTransfer(true, "첫_파일.jpg", FIRST);
        assertNull(batch.afterTransfer(false, "기존_파일.txt", SECOND));
        RecentReceive.Event latest = batch.afterTransfer(true, "다른_작업_결과.pdf", SECOND);
        assertEquals("첫_파일.jpg", latest.filename);
        assertEquals(2, latest.count);
        assertEquals(SECOND, latest.receivedAt);
        assertEquals(1, first.count);
        // A subsequent sync replaces this one batch; it never extends history counts.
        RecentReceive.Event next = new RecentReceive.Batch().afterTransfer(true, "다음_수신.txt", SECOND);
        assertEquals(1, next.count);
        assertEquals("다음_수신.txt", next.filename);
    }
    @Test public void sessionBindingSeparatesConnectionsWithoutKeepingIdentifiersOrTokens() throws Exception {
        String binding = RecentReceive.binding("https://diana.example", "fixture-phone");
        assertTrue(binding.matches("[a-f0-9]{64}"));
        assertEquals(binding, RecentReceive.binding("https://diana.example", "fixture-phone"));
        assertNotEquals(binding, RecentReceive.binding("https://other.example", "fixture-phone"));
        assertNotEquals(binding, RecentReceive.binding("https://diana.example", "other-phone"));
        assertNotEquals(RecentReceive.binding("ab", "c"), RecentReceive.binding("a", "bc"));
        assertFalse(binding.contains("fixture-phone"));
    }
}
