package kr.nightdesk.phone;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class Api {
    static class ApiException extends IOException {
        final int status;
        ApiException(int status) { super(status == 401 || status == 403 ? "휴대폰 연결 권한이 만료되었습니다. 다시 연결해 주세요." : "서버 응답을 확인해 주세요. (HTTP " + status + ")"); this.status = status; }
    }
    static String validateBase(String value, boolean debug) throws Exception {
        URI uri = new URI(value.trim()); String host = uri.getHost();
        boolean local = "127.0.0.1".equals(host) || "localhost".equals(host) || "10.0.2.2".equals(host);
        if (host == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null ||
            !("https".equalsIgnoreCase(uri.getScheme()) || (debug && local && "http".equalsIgnoreCase(uri.getScheme()))) ||
            !(uri.getPath() == null || uri.getPath().isEmpty() || "/".equals(uri.getPath()))) {
            throw new IOException("서버의 HTTPS 주소를 입력해 주세요. 경로·인증정보는 넣지 않습니다.");
        }
        return value.trim().replaceAll("/+$", "");
    }
    static HttpURLConnection connect(String base, String route, String token, String method) throws Exception {
        base = validateBase(base, BuildConfig.DEBUG);
        if (!route.startsWith("/api/") || route.contains("..")) throw new IOException("올바르지 않은 API 경로입니다.");
        HttpURLConnection connection = (HttpURLConnection) new URL(base + route).openConnection();
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15_000); connection.setReadTimeout(45_000);
        connection.setRequestMethod(method); connection.setRequestProperty("Accept", "application/json");
        if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
        return connection;
    }
    static JSONObject request(String base, String route, String token, JSONObject body) throws Exception {
        HttpURLConnection connection = connect(base, route, token, body == null ? "GET" : "POST");
        try {
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json"); connection.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream stream = connection.getOutputStream()) { stream.write(bytes); }
            }
            int status = connection.getResponseCode(); if (status < 200 || status >= 300) throw new ApiException(status);
            if (status == 204) return new JSONObject();
            try (InputStream stream = connection.getInputStream()) {
                ByteArrayOutputStream result = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
                while ((count = stream.read(buffer)) != -1) { if (result.size() + count > 2 * 1024 * 1024) throw new IOException("서버 목록이 너무 큽니다."); result.write(buffer, 0, count); }
                return new JSONObject(result.toString(StandardCharsets.UTF_8.name()));
            }
        } finally { connection.disconnect(); }
    }
    static JSONObject request(JSONObject session, String route, JSONObject body) throws Exception {
        return request(session.getString("baseUrl"), route, session.getString("phoneToken"), body);
    }
}
