// mvtls is the encrypted front door for the Dune Docker Console API.
//
// A viewer on someone's PC talks HTTPS to mvtls; mvtls forwards to the
// unchanged Console (http://127.0.0.1:8088). Nothing in Dune Docker has to
// change for the encryption, and everybody else keeps using the Console exactly
// as before.
//
//   - Own long-lived key (ECDSA P-256) in a volume, created on first start. The
//     certificate is self-signed and valid for 20 years; it is re-issued (same
//     key) when MV_TLS_NAMES changes. The fingerprint of the KEY is what clients
//     pin, so it never changes by itself and survives certificate re-issues.
//
//   - Default mode ("API door"): only GET/HEAD of /api/* and /images/maps/*,
//     only with "Authorization: Bearer dak_…" (images excepted), sessions and
//     cookies never pass, the Console's auth/settings/setup routes are not
//     reachable. The Console web UI is NOT exposed on this port.
//
//   - Failed API-key attempts are counted per client address here, because the
//     Console only sees 127.0.0.1 behind this proxy and would otherwise lump all
//     clients into one bucket.
//
//     mvtls                 serve
//     mvtls -pin            print the key fingerprint (sha256/…, not secret) and exit
//     mvtls -healthcheck    container health check
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
)

type config struct {
	Addr     string
	Upstream *url.URL
	State    string
	Names    []string
	Allow    []*net.IPNet
	Full     bool
}

func main() {
	pinOnly := flag.Bool("pin", false, "print the key fingerprint (sha256/…, not secret) and exit")
	health := flag.Bool("healthcheck", false, "check the local front door and exit")
	flag.Parse()
	log.SetFlags(log.LstdFlags | log.LUTC)

	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	id, err := loadOrCreateIdentity(cfg.State, cfg.Names)
	if err != nil {
		log.Fatal(err)
	}
	if *pinOnly {
		fmt.Println(pinOf(id.Leaf))
		return
	}
	if *health {
		os.Exit(healthcheck(cfg))
	}

	inner, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		log.Fatal(err)
	}
	ln := tls.NewListener(&allowListener{Listener: inner, allow: cfg.allowed}, &tls.Config{
		Certificates: []tls.Certificate{id},
		MinVersion:   tls.VersionTLS12,
		NextProtos:   []string{"http/1.1"}, // server-sent events and simple proxying
	})
	srv := &http.Server{
		Handler:           newHandler(cfg),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          log.New(os.Stderr, "mvtls http: ", log.LstdFlags|log.LUTC),
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(sctx)
	}()
	mode := "API door (GET /api/* and /images/maps/*, API key required)"
	if cfg.Full {
		mode = "FULL CONSOLE (web UI and login are exposed on this port too)"
	}
	log.Printf("mvtls: https://%s -> %s; mode: %s; allow list: %d entries", cfg.Addr, cfg.Upstream, mode, len(cfg.Allow))
	log.Printf("mvtls: key fingerprint %s – compare it with the one a client shows before you confirm it (show it again: mvtls -pin; on Dune Docker: dune encrypted-api fingerprint)", pinOf(id.Leaf))
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) && ctx.Err() == nil {
		log.Fatal(err)
	}
}

func loadConfig(env func(string) string) (config, error) {
	cfg := config{
		Addr:  envOr(env, "MV_TLS_ADDR", ":8797"),
		State: envOr(env, "MV_TLS_STATE", "/data"),
		Full:  env("MV_TLS_FULL") == "true" || env("MV_TLS_FULL") == "1",
	}
	u, err := url.Parse(envOr(env, "MV_TLS_UPSTREAM", "http://127.0.0.1:8088"))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return cfg, errors.New("MV_TLS_UPSTREAM: expected http://host:port")
	}
	cfg.Upstream = u
	for _, n := range splitList(env("MV_TLS_NAMES")) {
		if strings.ContainsAny(n, "/ :@") && net.ParseIP(n) == nil {
			return cfg, fmt.Errorf("MV_TLS_NAMES: %q is not a host name or IP address", n)
		}
		cfg.Names = append(cfg.Names, n)
	}
	for _, part := range splitList(env("MV_TLS_ALLOW")) {
		if !strings.Contains(part, "/") {
			if ip := net.ParseIP(part); ip != nil && ip.To4() != nil {
				part += "/32"
			} else {
				part += "/128"
			}
		}
		_, n, err := net.ParseCIDR(part)
		if err != nil {
			return cfg, fmt.Errorf("MV_TLS_ALLOW: %q is not an IP or CIDR", part)
		}
		cfg.Allow = append(cfg.Allow, n)
	}
	return cfg, nil
}

func splitList(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' })
}

func envOr(env func(string) string, k, def string) string {
	if v := env(k); v != "" {
		return v
	}
	return def
}

func (c config) allowed(ip net.IP) bool {
	if len(c.Allow) == 0 || (ip != nil && ip.IsLoopback()) {
		return true // loopback: the container's own health check
	}
	if ip == nil {
		return false
	}
	for _, n := range c.Allow {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- identity

// pinOf is the fingerprint of the certificate's public key:
// "sha256/" + base64url(SHA-256(SubjectPublicKeyInfo)).
func pinOf(cert *x509.Certificate) string {
	h := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	return "sha256/" + base64.RawURLEncoding.EncodeToString(h[:])
}

// loadOrCreateIdentity loads the key from dir or creates it. The certificate is
// (re)issued from the same key whenever it is missing, nearly expired or its
// names differ from names; the pin therefore stays the same.
func loadOrCreateIdentity(dir string, names []string) (tls.Certificate, error) {
	keyPath, certPath := filepath.Join(dir, "front-key.pem"), filepath.Join(dir, "front-cert.pem")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return tls.Certificate{}, err
	}
	var key *ecdsa.PrivateKey
	if b, err := os.ReadFile(keyPath); err == nil {
		blk, _ := pem.Decode(b)
		if blk == nil {
			return tls.Certificate{}, fmt.Errorf("%s: no PEM data", keyPath)
		}
		if key, err = x509.ParseECPrivateKey(blk.Bytes); err != nil {
			return tls.Certificate{}, fmt.Errorf("%s: %w", keyPath, err)
		}
	} else if errors.Is(err, os.ErrNotExist) {
		if key, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader); err != nil {
			return tls.Certificate{}, err
		}
		kb, err := x509.MarshalECPrivateKey(key)
		if err != nil {
			return tls.Certificate{}, err
		}
		if err := writeFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600); err != nil {
			return tls.Certificate{}, err
		}
	} else {
		return tls.Certificate{}, err
	}

	if b, err := os.ReadFile(certPath); err == nil {
		if blk, _ := pem.Decode(b); blk != nil {
			if cert, err := x509.ParseCertificate(blk.Bytes); err == nil && certMatches(cert, key, names) {
				return tls.Certificate{Certificate: [][]byte{blk.Bytes}, PrivateKey: key, Leaf: cert}, nil
			}
		}
	}
	der, err := issue(key, names)
	if err != nil {
		return tls.Certificate{}, err
	}
	if err := writeFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return tls.Certificate{}, err
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}, nil
}

func certNames(names []string) (dns []string, ips []net.IP) {
	for _, n := range names {
		if ip := net.ParseIP(n); ip != nil {
			ips = append(ips, ip)
		} else {
			dns = append(dns, strings.ToLower(n))
		}
	}
	return dns, ips
}

func certMatches(cert *x509.Certificate, key *ecdsa.PrivateKey, names []string) bool {
	pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok || !pub.Equal(&key.PublicKey) || time.Until(cert.NotAfter) < 90*24*time.Hour {
		return false
	}
	dns, ips := certNames(names)
	slices.Sort(dns)
	have := slices.Clone(cert.DNSNames)
	slices.Sort(have)
	if !slices.Equal(dns, have) || len(ips) != len(cert.IPAddresses) {
		return false
	}
	for _, ip := range ips {
		if !slices.ContainsFunc(cert.IPAddresses, ip.Equal) {
			return false
		}
	}
	return true
}

func issue(key *ecdsa.PrivateKey, names []string) ([]byte, error) {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return nil, err
	}
	dns, ips := certNames(names)
	now := time.Now()
	tpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "Dune Docker encrypted API access"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.AddDate(20, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              dns,
		IPAddresses:           ips,
	}
	return x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
}

func writeFile(path string, b []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ---------------------------------------------------------------- listener

// allowListener closes connections of addresses outside the allow list before
// any TLS work is done.
type allowListener struct {
	net.Listener
	allow func(net.IP) bool
}

func (l *allowListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if l.allow(peerIP(c.RemoteAddr())) {
			return c, nil
		}
		c.Close()
	}
}

func peerIP(a net.Addr) net.IP {
	if t, ok := a.(*net.TCPAddr); ok {
		return t.IP
	}
	host, _, _ := net.SplitHostPort(a.String())
	return net.ParseIP(host)
}

// ---------------------------------------------------------------- handler

// Console routes that are never reachable through the API door, even with a key.
var blockedPrefixes = []string{"/api/auth/", "/api/settings/", "/api/setup/", "/api/discord/"}

func newHandler(cfg config) http.Handler {
	fails := newFailLimiter(10, time.Minute, 10*time.Minute)
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(cfg.Upstream)
			if cfg.Full {
				r.Out.Header["X-Forwarded-For"] = nil
				return
			}
			// API door: nothing but the key and what the API needs
			h := http.Header{}
			for _, k := range []string{"Authorization", "Accept", "Accept-Encoding", "Range", "If-None-Match", "If-Modified-Since"} {
				if v := r.In.Header[k]; v != nil {
					h[k] = v
				}
			}
			r.Out.Header = h
		},
		FlushInterval: -1, // server-sent events: pass every write on at once
		ModifyResponse: func(resp *http.Response) error {
			if !cfg.Full {
				resp.Header.Del("Set-Cookie")
			}
			if resp.StatusCode == http.StatusUnauthorized {
				if ip, ok := resp.Request.Context().Value(clientKey{}).(net.IP); ok && fails.fail(ip) {
					log.Printf("mvtls: %s blocked for 10 minutes after repeated rejected API keys", ip)
				}
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if r.Context().Err() == nil {
				log.Printf("mvtls: console unreachable: %v", err)
			}
			http.Error(w, "console unreachable", http.StatusBadGateway)
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := peerIP(addrOf(r))
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Strict-Transport-Security", "max-age=31536000")

		if r.URL.Path == "/mvtls" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
			// identification for clients; nothing secret, sent without any login
			h.Set("Content-Type", "application/json")
			h.Set("Cache-Control", "no-store")
			h.Set("Access-Control-Allow-Origin", "*")
			json.NewEncoder(w).Encode(map[string]any{"mapviewer-tls": 1, "full": cfg.Full})
			return
		}
		if fails.blocked(ip) {
			h.Set("Retry-After", "600")
			http.Error(w, "too many rejected API keys", http.StatusTooManyRequests)
			return
		}
		if !cfg.Full {
			if code := apiDoorRefusal(r); code != 0 {
				http.Error(w, http.StatusText(code), code)
				return
			}
		}
		proxy.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), clientKey{}, ip)))
	})
}

type clientKey struct{}

func addrOf(r *http.Request) net.Addr {
	a, err := net.ResolveTCPAddr("tcp", r.RemoteAddr)
	if err != nil {
		return &net.TCPAddr{}
	}
	return a
}

// apiDoorRefusal returns the status code to refuse the request with, or 0.
func apiDoorRefusal(r *http.Request) int {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return http.StatusMethodNotAllowed
	}
	p := r.URL.Path
	if strings.Contains(p, "..") || strings.Contains(p, "//") || strings.Contains(p, `\`) {
		return http.StatusBadRequest
	}
	if strings.HasPrefix(p, "/images/maps/") {
		return 0 // public marker images of the Console, no key needed
	}
	if p == "/api/health" {
		return 0
	}
	if !strings.HasPrefix(p, "/api/") {
		return http.StatusNotFound
	}
	for _, b := range blockedPrefixes {
		if strings.HasPrefix(p, b) {
			return http.StatusNotFound
		}
	}
	if a := r.Header.Get("Authorization"); len(a) < 12 || !strings.EqualFold(a[:7], "bearer ") || !strings.HasPrefix(strings.TrimSpace(a[7:]), "dak_") {
		return http.StatusUnauthorized
	}
	return 0
}

// failLimiter blocks an address after max rejected API keys within window.
type failLimiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	block  time.Duration
	now    func() time.Time
	ips    map[string]*failEntry
}

type failEntry struct {
	first, until time.Time
	n            int
}

func newFailLimiter(max int, window, block time.Duration) *failLimiter {
	return &failLimiter{max: max, window: window, block: block, now: time.Now, ips: map[string]*failEntry{}}
}

func (l *failLimiter) blocked(ip net.IP) bool {
	if ip == nil || ip.IsLoopback() {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.ips[ip.String()]
	return e != nil && l.now().Before(e.until)
}

// fail records a rejected key and reports whether the address just got blocked.
func (l *failLimiter) fail(ip net.IP) bool {
	if ip == nil || ip.IsLoopback() {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if len(l.ips) > 10000 {
		for k, e := range l.ips {
			if now.Sub(e.first) > l.window && now.After(e.until) {
				delete(l.ips, k)
			}
		}
	}
	k := ip.String()
	e := l.ips[k]
	if e == nil || now.Sub(e.first) > l.window {
		e = &failEntry{first: now}
		l.ips[k] = e
	}
	e.n++
	if e.n >= l.max {
		e.until = now.Add(l.block)
		e.n, e.first = 0, now
		return true
	}
	return false
}

// ---------------------------------------------------------------- health check

func healthcheck(cfg config) int {
	_, port, err := net.SplitHostPort(cfg.Addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	c := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
		// the certificate is not for 127.0.0.1; this only asks the front door itself
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}}
	resp, err := c.Get("https://127.0.0.1:" + port + "/mvtls")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "mvtls:", resp.Status)
		return 1
	}
	return 0
}
