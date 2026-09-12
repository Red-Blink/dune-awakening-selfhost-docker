package main

import (
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestDirectCandidatesUseDedicatedUDPRange(t *testing.T) {
	if probeUDPPortMax-probeUDPPortMin+1 < maxSessions {
		t.Fatalf("UDP range %d-%d cannot serve %d concurrent sessions", probeUDPPortMin, probeUDPPortMax, maxSessions)
	}

	rtcAPI, err := newWebRTCAPI()
	if err != nil {
		t.Fatalf("create WebRTC API: %v", err)
	}
	peer, err := rtcAPI.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("create peer connection: %v", err)
	}
	defer peer.Close()
	if _, err := peer.CreateDataChannel("range-test", nil); err != nil {
		t.Fatalf("create data channel: %v", err)
	}
	offer, err := peer.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	gatheringComplete := webrtc.GatheringCompletePromise(peer)
	if err := peer.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local description: %v", err)
	}
	select {
	case <-gatheringComplete:
	case <-time.After(5 * time.Second):
		t.Fatal("ICE gathering timed out")
	}

	local := peer.LocalDescription()
	if local == nil {
		t.Fatal("local description is missing")
	}
	foundUDP := false
	for _, line := range strings.Split(local.SDP, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 6 || !strings.HasPrefix(fields[0], "a=candidate:") || !strings.EqualFold(fields[2], "udp") {
			continue
		}
		port, err := strconv.Atoi(fields[5])
		if err != nil {
			t.Fatalf("parse candidate port %q: %v", fields[5], err)
		}
		if port < probeUDPPortMin || port > probeUDPPortMax {
			t.Fatalf("UDP candidate port %d is outside %d-%d", port, probeUDPPortMin, probeUDPPortMax)
		}
		foundUDP = true
	}
	if !foundUDP {
		t.Fatal("no UDP host candidate was gathered")
	}
}
