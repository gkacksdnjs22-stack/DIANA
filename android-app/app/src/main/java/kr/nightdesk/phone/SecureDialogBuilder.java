package kr.nightdesk.phone;

import android.app.AlertDialog;
import android.content.Context;
import android.view.WindowManager;

/** Protect every dialog window before its first visible frame. */
final class SecureDialogBuilder extends AlertDialog.Builder {
    SecureDialogBuilder(Context context){super(context);}
    @Override public AlertDialog create(){
        AlertDialog dialog=super.create();
        dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        return dialog;
    }
}
