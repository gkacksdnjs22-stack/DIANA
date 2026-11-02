package kr.nightdesk.phone;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

final class NativePkce {
    static final String ORIGIN="http://localhost:43871", REDIRECT="kr.nightdesk.phone.lab.passkey://oauth2/callback";
    static String random(){byte[] b=new byte[32];new SecureRandom().nextBytes(b);return Base64.getUrlEncoder().withoutPadding().encodeToString(b);}
    static String challenge(String verifier)throws Exception{return Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));}
    static String enc(String x)throws Exception{return URLEncoder.encode(x,"UTF-8");}
    static String authorize(String state,String verifier)throws Exception{return ORIGIN+"/authorize?response_type=code&client_id=diana-lab-android&redirect_uri="+enc(REDIRECT)+"&state="+state+"&code_challenge_method=S256&code_challenge="+challenge(verifier);}
    static String code(String callback,String state)throws Exception{
        URI u=new URI(callback);if(!"kr.nightdesk.phone.lab.passkey".equals(u.getScheme())||!"oauth2".equals(u.getHost())||!"/callback".equals(u.getPath())||u.getFragment()!=null||u.getUserInfo()!=null||u.getPort()!=-1)throw new Exception();
        Map<String,String> values=new HashMap<>();for(String part:u.getRawQuery().split("&")){String[] p=part.split("=",2);if(p.length!=2||values.containsKey(p[0]))throw new Exception();values.put(p[0],URLDecoder.decode(p[1],"UTF-8"));}
        if(values.size()!=2||!state.equals(values.get("state"))||!values.getOrDefault("code","").matches("[A-Za-z0-9_-]{43}"))throw new Exception();return values.get("code");
    }
}
