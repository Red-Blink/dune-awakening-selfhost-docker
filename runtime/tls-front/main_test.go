package main

import (
	"bufio"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const key = "Bearer dak_test_0123456789"

func TestForwardingIdentity(t *testing.T) {
	dir := t.TempDir()
	secret, err := loadOrCreateProxyKey(dir)
	if err != nil {
		t.Fatal(err)
	}
	again, err := loadOrCreateProxyKey(dir)
	if err != nil || !hmac.Equal(secret, again) {
		t.Fatal("forwarding identity changed")
	}
	stat, _ := os.Stat(filepath.Join(dir, "proxy-key"))
	if stat.Mode().Perm() != 0o600 {
		t.Fatal("forwarding key permissions")
	}
	req := httptest.NewRequest("GET", "http://console/api/server/status?view=1", nil)
	req.RemoteAddr = "203.0.113.9:12345"
	proxy := &httputil.ProxyRequest{In: req, Out: req.Clone(req.Context())}
	signClient(proxy, secret)
	h := proxy.Out.Header
	if h.Get("X-Dune-Tls-Client") != "203.0.113.9" {
		t.Fatal("client IP missing")
	}
	mac := hmac.New(sha256.New, secret)
	fmt.Fprintf(mac, "%s\n203.0.113.9\nGET\n/api/server/status?view=1", h.Get("X-Dune-Tls-Time"))
	if h.Get("X-Dune-Tls-Signature") != hex.EncodeToString(mac.Sum(nil)) {
		t.Fatal("request signature mismatch")
	}
}

func TestHealthCheckRequiresReachableConsole(t *testing.T) {
	base, _, _ := start(t, nil)
	front, _ := url.Parse(base)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden) // restrictive Console allowlist
	}))
	upstream, _ := url.Parse(backend.URL)
	cfg := config{Addr: front.Host, Upstream: upstream}
	if healthcheck(cfg) != 0 {
		t.Fatal("reachable restricted Console was unhealthy")
	}
	backend.Close()
	if healthcheck(cfg) == 0 {
		t.Fatal("unreachable Console was reported healthy")
	}
}

// console is a stand-in for the Dune Docker Console: it records what reached it.
func console(t *testing.T, seen chan<- *http.Request) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"ok":true}`) })
	mux.HandleFunc("/api/map/status", func(w http.ResponseWriter, r *http.Request) {
		seen <- r
		if r.Header.Get("Authorization") != key {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Set-Cookie", "session=abc")
		io.WriteString(w, `{"rows":[]}`)
	})
	mux.HandleFunc("/api/stream-test", func(w http.ResponseWriter, r *http.Request) {
		seen <- r
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "event: snap\ndata: {}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	mux.HandleFunc("/images/maps/x.png", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "PNG") })
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { seen <- r; io.WriteString(w, "console ui") })
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

// start runs the real front door (TLS + handler) in front of a console stub.
func start(t *testing.T, env map[string]string) (base string, pin string, seen chan *http.Request) {
	t.Helper()
	seen = make(chan *http.Request, 32)
	m := map[string]string{"MV_TLS_UPSTREAM": console(t, seen).URL, "MV_TLS_STATE": t.TempDir()}
	for k, v := range env {
		m[k] = v
	}
	cfg, err := loadConfig(func(k string) string { return m[k] })
	if err != nil {
		t.Fatal(err)
	}
	id, err := loadOrCreateIdentity(cfg.State, cfg.Names)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ProxyKey, err = loadOrCreateProxyKey(cfg.State)
	if err != nil {
		t.Fatal(err)
	}
	inner, _ := net.Listen("tcp", "127.0.0.1:0")
	ln := tls.NewListener(&allowListener{Listener: inner, allow: cfg.allowed}, &tls.Config{Certificates: []tls.Certificate{id}, MinVersion: tls.VersionTLS12})
	srv := &http.Server{Handler: newHandler(cfg)}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return "https://" + inner.Addr().String(), pinOf(id.Leaf), seen
}

// client trusts exactly the pinned key, like a real client does.
func client(pin string) *http.Client {
	return &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{
		InsecureSkipVerify: true,
		VerifyConnection: func(cs tls.ConnectionState) error {
			if pinOf(cs.PeerCertificates[0]) != pin {
				return io.ErrUnexpectedEOF
			}
			return nil
		},
	}}}
}

func get(t *testing.T, c *http.Client, u string, hdr map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestKeyAndPinAreStableAndPrivate(t *testing.T) {
	dir := t.TempDir()
	a, err := loadOrCreateIdentity(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := loadOrCreateIdentity(dir, nil)
	if err != nil || pinOf(a.Leaf) != pinOf(b.Leaf) || string(a.Leaf.Raw) != string(b.Leaf.Raw) {
		t.Fatal("identity changed on reload")
	}
	// new names: certificate re-issued, key and pin unchanged
	c, err := loadOrCreateIdentity(dir, []string{"dune.example.org", "203.0.113.7"})
	if err != nil || pinOf(c.Leaf) != pinOf(a.Leaf) {
		t.Fatal("pin changed with the names")
	}
	if len(c.Leaf.DNSNames) != 1 || len(c.Leaf.IPAddresses) != 1 {
		t.Fatalf("names missing in the certificate: %v %v", c.Leaf.DNSNames, c.Leaf.IPAddresses)
	}
	if time.Until(c.Leaf.NotAfter) < 19*365*24*time.Hour {
		t.Fatal("certificate does not live long")
	}
	if st, _ := os.Stat(filepath.Join(dir, "front-key.pem")); st.Mode().Perm() != 0o600 {
		t.Fatalf("key mode %v", st.Mode().Perm())
	}
}

func TestIdentificationNeedsNoLogin(t *testing.T) {
	base, pin, seen := start(t, nil)
	resp := get(t, client(pin), base+"/mvtls", nil)
	if resp.StatusCode != 200 || !strings.Contains(resp.Header.Get("Content-Type"), "json") {
		t.Fatalf("%d", resp.StatusCode)
	}
	select {
	case r := <-seen:
		t.Fatalf("%s reached the console", r.URL)
	default:
	}
}

func TestWrongPinIsRefusedByClient(t *testing.T) {
	base, _, _ := start(t, nil)
	if _, err := client("sha256/" + strings.Repeat("A", 43)).Get(base + "/mvtls"); err == nil {
		t.Fatal("connected with the wrong pin")
	}
}

func TestAPIDoorOnlyForwardsKeyedReads(t *testing.T) {
	base, pin, seen := start(t, nil)
	c := client(pin)
	auth := map[string]string{"Authorization": key}

	// forwarded, cookie of the console never passes, only the headers the API needs
	resp := get(t, c, base+"/api/map/status", map[string]string{"Authorization": key, "Cookie": "session=admin", "X-Forwarded-For": "1.2.3.4", "X-Dune-Tls-Client": "1.2.3.4", "X-Dune-Tls-Signature": "forged"})
	if resp.StatusCode != 200 || resp.Header.Get("Set-Cookie") != "" {
		t.Fatalf("status %d, cookie %q", resp.StatusCode, resp.Header.Get("Set-Cookie"))
	}
	r := <-seen
	if r.Header.Get("X-Dune-Tls-Client") != "127.0.0.1" || len(r.Header.Get("X-Dune-Tls-Signature")) != 64 {
		t.Fatal("forwarded identity was not signed from the real client")
	}
	if r.Header.Get("Cookie") != "" || r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("Authorization") != key {
		t.Fatalf("headers: %v", r.Header)
	}
	// public images without a key
	if get(t, c, base+"/images/maps/x.png", nil).StatusCode != 200 {
		t.Fatal("image refused")
	}
	for path, want := range map[string]int{
		"/api/map/status":        401, // no key: refused here, never reaches the console
		"/":                      404, // the Console web UI is not exposed
		"/index.html":            404,
		"/api/auth/login":        404,
		"/api/settings/api-keys": 404,
		"/api/setup/state":       404,
		"/api/../api/settings/x": 400,
		"/api//settings/x":       400,
		"/images/maps/../../x":   400,
	} {
		h := auth
		if want == 401 {
			h = nil
		}
		if got := get(t, c, base+path, h).StatusCode; got != want {
			t.Errorf("%s: %d, want %d", path, got, want)
		}
	}
	// a non-dak bearer is refused too
	if get(t, c, base+"/api/map/status", map[string]string{"Authorization": "Bearer something-else"}).StatusCode != 401 {
		t.Error("non-dak bearer forwarded")
	}
	req, _ := http.NewRequest(http.MethodPost, base+"/api/map/status", strings.NewReader("x"))
	req.Header.Set("Authorization", key)
	resp2, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != 405 {
		t.Errorf("POST: %d", resp2.StatusCode)
	}
	for len(seen) > 0 {
		r := <-seen
		if r.URL.Path != "/api/map/status" {
			t.Errorf("unexpected request %s %s reached the console", r.Method, r.URL)
		}
	}
}

func TestFullModeForwardsEverything(t *testing.T) {
	base, pin, seen := start(t, map[string]string{"MV_TLS_FULL": "true"})
	resp := get(t, client(pin), base+"/", map[string]string{"Cookie": "session=admin"})
	b, _ := io.ReadAll(resp.Body)
	if string(b) != "console ui" {
		t.Fatalf("UI not forwarded: %q", b)
	}
	if r := <-seen; r.Header.Get("Cookie") == "" {
		t.Fatal("full mode dropped the session cookie")
	}
}

func TestStreamIsFlushed(t *testing.T) {
	base, pin, _ := start(t, nil)
	c := client(pin)
	c.Timeout = 0
	resp := get(t, c, base+"/api/stream-test", map[string]string{"Authorization": key})
	line := make(chan string, 1)
	go func() { s, _ := bufio.NewReader(resp.Body).ReadString('\n'); line <- s }()
	select {
	case s := <-line:
		if !strings.HasPrefix(s, "event: snap") {
			t.Fatalf("first line %q", s)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("stream data was buffered instead of flushed")
	}
}

func TestRejectedKeysBlockTheAddress(t *testing.T) {
	// a console that rejects every key: the front must not let one client drain the console's shared limiter
	seen := make(chan *http.Request, 64)
	m := map[string]string{"MV_TLS_UPSTREAM": console(t, seen).URL, "MV_TLS_STATE": t.TempDir()}
	cfg, _ := loadConfig(func(k string) string { return m[k] })
	h := newHandler(cfg)
	for i := 0; i < 10; i++ {
		req := httptest.NewRequest("GET", "/api/map/status", nil)
		req.RemoteAddr = "198.51.100.7:5000"
		req.Header.Set("Authorization", "Bearer dak_wrong_wrong_wrong")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != 401 {
			t.Fatalf("attempt %d: %d", i, rec.Code)
		}
	}
	req := httptest.NewRequest("GET", "/api/map/status", nil)
	req.RemoteAddr = "198.51.100.7:5000"
	req.Header.Set("Authorization", key)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 429 {
		t.Fatalf("right key after 10 rejections: %d", rec.Code)
	}
	// another address is not affected
	req = httptest.NewRequest("GET", "/api/map/status", nil)
	req.RemoteAddr = "198.51.100.8:5000"
	req.Header.Set("Authorization", key)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("other address: %d", rec.Code)
	}
}

func TestAllowList(t *testing.T) {
	cfg, err := loadConfig(func(k string) string { return map[string]string{"MV_TLS_ALLOW": "203.0.113.7, 10.0.0.0/8"}[k] })
	if err != nil || !cfg.allowed(net.ParseIP("10.1.2.3")) || cfg.allowed(net.ParseIP("198.51.100.1")) || !cfg.allowed(net.ParseIP("127.0.0.1")) {
		t.Fatalf("allow list: %v", err)
	}
	base, pin, _ := start(t, map[string]string{"MV_TLS_ALLOW": "203.0.113.7"})
	// 127.0.0.1 is always allowed (health check), so test the listener with a foreign-looking policy
	if get(t, client(pin), base+"/mvtls", nil).StatusCode != 200 {
		t.Fatal("loopback refused")
	}
}

func TestConfigErrors(t *testing.T) {
	for _, bad := range []map[string]string{
		{"MV_TLS_UPSTREAM": "ftp://x"}, {"MV_TLS_UPSTREAM": "http://u:p@127.0.0.1:8088"},
		{"MV_TLS_ALLOW": "nope"}, {"MV_TLS_NAMES": "a/b"},
	} {
		if _, err := loadConfig(func(k string) string { return bad[k] }); err == nil {
			t.Errorf("accepted %v", bad)
		}
	}
}

func TestFailLimiterExpires(t *testing.T) {
	now := time.Unix(0, 0)
	l := newFailLimiter(2, time.Minute, 10*time.Minute)
	l.now = func() time.Time { return now }
	ip := net.ParseIP("198.51.100.1")
	l.fail(ip)
	now = now.Add(2 * time.Minute)
	if l.fail(ip) || l.blocked(ip) {
		t.Fatal("blocked although the failures were in different windows")
	}
	if !l.fail(ip) || !l.blocked(ip) {
		t.Fatal("not blocked after 2 failures in one window")
	}
	now = now.Add(11 * time.Minute)
	if l.blocked(ip) {
		t.Fatal("block did not expire")
	}
	if l.fail(net.ParseIP("127.0.0.1")) {
		t.Fatal("loopback must never be blocked")
	}
}
