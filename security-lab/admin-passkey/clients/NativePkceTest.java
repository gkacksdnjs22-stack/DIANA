package kr.nightdesk.phone;
import org.junit.Test;
import static org.junit.Assert.*;
public class NativePkceTest {
    @Test public void rfc7636Vector()throws Exception{assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",NativePkce.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));}
    @Test public void randomHas256Bits(){String a=NativePkce.random();assertEquals(43,a.length());assertNotEquals(a,NativePkce.random());}
    @Test public void callbackExact()throws Exception{String s=NativePkce.random(),code=NativePkce.random();assertEquals(code,NativePkce.code(NativePkce.REDIRECT+"?code="+code+"&state="+s,s));}
    @Test public void rejectForgedCallbacks()throws Exception{String s=NativePkce.random(),c=NativePkce.random();String[] bad={"https://evil/callback?code="+c+"&state="+s,NativePkce.REDIRECT+"?code="+c+"&state=wrong",NativePkce.REDIRECT+"?code="+c+"&state="+s+"&state="+s,NativePkce.REDIRECT+"?code="+c+"&state="+s+"#injected",NativePkce.REDIRECT+"?code="+c+"&state="+s+"&extra=1"};for(String x:bad){try{NativePkce.code(x,s);fail("Accepted forged callback");}catch(Exception expected){}}}
    @Test public void publicClientHasNoSecret()throws Exception{String url=NativePkce.authorize(NativePkce.random(),NativePkce.random());assertTrue(url.startsWith("http://localhost:43871/authorize?"));assertTrue(url.contains("code_challenge_method=S256"));assertFalse(url.contains("client_secret"));assertFalse(url.contains("code_verifier"));}
}
