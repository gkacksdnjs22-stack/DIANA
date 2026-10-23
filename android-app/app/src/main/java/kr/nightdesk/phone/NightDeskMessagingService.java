package kr.nightdesk.phone;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
public final class NightDeskMessagingService extends FirebaseMessagingService {
    @Override public void onMessageReceived(RemoteMessage message) {
        if (!SyncScheduler.enabled(this) || !PushSupport.paired(this) || !PushConfig.filesReady(message.getData())) return;
        Notifications.pending(this);
        SyncScheduler.fromPush(this, message.getPriority() == RemoteMessage.PRIORITY_HIGH);
    }
    @Override public void onDeletedMessages() { if (SyncScheduler.enabled(this)) SyncScheduler.once(this); }
    @Override public void onNewToken(String token) { PushSupport.register(getApplicationContext(), token); }
}
