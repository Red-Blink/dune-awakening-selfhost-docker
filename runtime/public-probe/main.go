package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	maxResponseBytes = 128 * 1024
	maxMessageBytes  = 256
	maxSessions      = 4
	sessionLifetime  = 20 * time.Second
)

type config struct {
	serverID  string
	secret    string
	signalURL string
}

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type probeJob struct {
	SessionID string      `json:"sessionId"`
	Offer     string      `json:"offer"`
	ICE       []iceServer `json:"iceServers"`
}

type answerPayload struct {
	Answer string `json:"answer"`
}

type agent struct {
	config config
	client *http.Client
	wg     sync.WaitGroup
	slots  chan struct{}
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	a := &agent{
		config: cfg,
		client: &http.Client{
			Timeout: 35 * time.Second,
			Transport: &http.Transport{
				ForceAttemptHTTP2:   true,
				MaxIdleConns:        4,
				MaxIdleConnsPerHost: 2,
				IdleConnTimeout:     90 * time.Second,
			},
		},
		slots: make(chan struct{}, maxSessions),
	}
	log.Printf("WebRTC probe agent starting for server %s", cfg.serverID)
	a.run(ctx)
	a.wg.Wait()
}

func loadConfig() (config, error) {
	cfg := config{
		serverID:  strings.TrimSpace(os.Getenv("DUNE_PUBLIC_PROBE_SERVER_ID")),
		secret:    strings.TrimSpace(os.Getenv("DUNE_PUBLIC_PROBE_SECRET")),
		signalURL: strings.TrimRight(strings.TrimSpace(os.Getenv("DUNE_PUBLIC_PROBE_SIGNAL_URL")), "/"),
	}
	if cfg.serverID == "" || cfg.secret == "" || cfg.signalURL == "" {
		return config{}, errors.New("probe server ID, secret, and signaling URL are required")
	}
	if !strings.HasPrefix(cfg.signalURL, "https://dunedocker.app/") {
		return config{}, errors.New("probe signaling URL must use https://dunedocker.app")
	}
	return cfg, nil
}

func (a *agent) run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		select {
		case a.slots <- struct{}{}:
		case <-ctx.Done():
			return
		}
		job, err := a.nextJob(ctx)
		if err != nil {
			<-a.slots
			if ctx.Err() != nil {
				break
			}
			log.Printf("signaling poll failed: %v", err)
			if !sleepContext(ctx, backoff) {
				break
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
		if job == nil {
			<-a.slots
			continue
		}
		a.wg.Add(1)
		go func() {
			defer a.wg.Done()
			defer func() { <-a.slots }()
			if err := a.handleJob(ctx, *job); err != nil {
				log.Printf("probe session %s failed: %v", job.SessionID, err)
			}
		}()
	}
}

func (a *agent) nextJob(ctx context.Context) (*probeJob, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.config.signalURL+"/agent/next", nil)
	if err != nil {
		return nil, err
	}
	a.authorize(req)
	response, err := a.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, responseError(response)
	}
	var job probeJob
	if err := decodeJSON(response.Body, &job); err != nil {
		return nil, err
	}
	if job.SessionID == "" || job.Offer == "" || len(job.ICE) == 0 {
		return nil, errors.New("signaling server returned an incomplete probe job")
	}
	return &job, nil
}

func (a *agent) handleJob(parent context.Context, job probeJob) error {
	ctx, cancel := context.WithTimeout(parent, sessionLifetime)
	defer cancel()

	configuration := webrtc.Configuration{ICEServers: make([]webrtc.ICEServer, 0, len(job.ICE))}
	for _, server := range job.ICE {
		if len(server.URLs) == 0 {
			continue
		}
		configuration.ICEServers = append(configuration.ICEServers, webrtc.ICEServer{
			URLs:           server.URLs,
			Username:       server.Username,
			Credential:     server.Credential,
			CredentialType: webrtc.ICECredentialTypePassword,
		})
	}

	peer, err := webrtc.NewPeerConnection(configuration)
	if err != nil {
		return err
	}
	defer peer.Close()

	connected := make(chan struct{}, 1)
	closed := make(chan struct{}, 1)
	peer.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			select {
			case connected <- struct{}{}:
			default:
			}
		}
		if state == webrtc.PeerConnectionStateFailed ||
			state == webrtc.PeerConnectionStateDisconnected ||
			state == webrtc.PeerConnectionStateClosed {
			select {
			case closed <- struct{}{}:
			default:
			}
		}
	})
	peer.OnDataChannel(func(channel *webrtc.DataChannel) {
		var messages int
		channel.OnMessage(func(message webrtc.DataChannelMessage) {
			if !message.IsString || len(message.Data) == 0 || len(message.Data) > maxMessageBytes || messages >= 20 {
				return
			}
			messages++
			if err := channel.SendText(string(message.Data)); err != nil {
				log.Printf("probe session %s echo failed: %v", job.SessionID, err)
			}
		})
	})

	if err := peer.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  job.Offer,
	}); err != nil {
		return fmt.Errorf("set offer: %w", err)
	}
	answer, err := peer.CreateAnswer(nil)
	if err != nil {
		return fmt.Errorf("create answer: %w", err)
	}
	gatheringComplete := webrtc.GatheringCompletePromise(peer)
	if err := peer.SetLocalDescription(answer); err != nil {
		return fmt.Errorf("set answer: %w", err)
	}
	select {
	case <-gatheringComplete:
	case <-ctx.Done():
		return ctx.Err()
	}
	local := peer.LocalDescription()
	if local == nil || local.SDP == "" {
		return errors.New("WebRTC answer was empty")
	}
	if err := a.submitAnswer(ctx, job.SessionID, local.SDP); err != nil {
		return err
	}

	select {
	case <-connected:
		log.Printf("probe session %s connected", job.SessionID)
	case <-closed:
		return errors.New("WebRTC connection closed before becoming ready")
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-closed:
	case <-ctx.Done():
	}
	return nil
}

func (a *agent) submitAnswer(ctx context.Context, sessionID, answer string) error {
	body, err := json.Marshal(answerPayload{Answer: answer})
	if err != nil {
		return err
	}
	url := fmt.Sprintf("%s/agent/sessions/%s/answer", a.config.signalURL, sessionID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	a.authorize(req)
	response, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return responseError(response)
	}
	return nil
}

func (a *agent) authorize(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+a.config.secret)
	req.Header.Set("X-Dune-Server-ID", a.config.serverID)
}

func decodeJSON(reader io.Reader, target any) error {
	decoder := json.NewDecoder(io.LimitReader(reader, maxResponseBytes))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func responseError(response *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
	message := strings.TrimSpace(string(body))
	if message == "" {
		message = response.Status
	}
	return fmt.Errorf("signaling server returned HTTP %d: %s", response.StatusCode, message)
}

func sleepContext(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}
