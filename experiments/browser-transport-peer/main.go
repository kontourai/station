package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"sync"
	"syscall"
	"time"

	"github.com/pion/webrtc/v4"
)

type config struct {
	Offer                                     webrtc.SessionDescription
	Certificate, Key, URL, Username, Password string
}

func publish(dir, name string, value any) error {
	bytes, err := json.Marshal(value)
	if err != nil {
		return err
	}
	path := filepath.Join(dir, name)
	if err = os.WriteFile(path+".tmp", bytes, 0600); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}
func run(dir string) error {
	build, ok := debug.ReadBuildInfo()
	if !ok {
		return errors.New("missing Go build provenance")
	}
	version := ""
	for _, dependency := range build.Deps {
		if dependency.Path == "github.com/pion/webrtc/v4" && dependency.Replace == nil {
			version = dependency.Version
		}
	}
	if version != "v4.2.20" {
		return errors.New("unexpected Pion dependency")
	}
	if err := publish(dir, "version.json", map[string]string{"pion": version, "go": build.GoVersion}); err != nil {
		return err
	}
	file, err := os.Open(filepath.Join(dir, "config.json"))
	if err != nil {
		return err
	}
	defer file.Close()
	bytes, err := io.ReadAll(io.LimitReader(file, 128*1024+1))
	if err != nil {
		return err
	}
	if len(bytes) > 128*1024 {
		return errors.New("fixture configuration exceeds bound")
	}
	var cfg config
	if err = json.Unmarshal(bytes, &cfg); err != nil {
		return err
	}
	key, err := tls.LoadX509KeyPair(cfg.Certificate, cfg.Key)
	if err != nil {
		return err
	}
	cert, err := x509.ParseCertificate(key.Certificate[0])
	if err != nil {
		return err
	}
	setting := webrtc.SettingEngine{}
	setting.SetIncludeLoopbackCandidate(true)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(setting))
	pc, err := api.NewPeerConnection(webrtc.Configuration{ICEServers: []webrtc.ICEServer{{URLs: []string{cfg.URL}, Username: cfg.Username, Credential: cfg.Password}}, ICETransportPolicy: webrtc.ICETransportPolicyRelay, Certificates: []webrtc.Certificate{webrtc.CertificateFromX509(key.PrivateKey, cert)}})
	if err != nil {
		return err
	}
	defer pc.Close()
	var mu sync.Mutex
	var stateMu sync.Mutex
	messages := []string{}
	asyncErrors := make(chan error, 1)
	reportFailure := func(err error) {
		select {
		case asyncErrors <- err:
		default:
		}
	}
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		stateMu.Lock()
		defer stateMu.Unlock()
		if err := publish(dir, "state.json", map[string]any{"state": s.String()}); err != nil {
			reportFailure(err)
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		dc.OnMessage(func(message webrtc.DataChannelMessage) {
			if !message.IsString || len(message.Data) > 65536 {
				_ = dc.Close()
				return
			}
			pair, e := pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
			if e != nil || pair == nil {
				_ = dc.Close()
				return
			}
			mu.Lock()
			defer mu.Unlock()
			if len(messages) >= 8 {
				_ = dc.Close()
				return
			}
			messages = append(messages, string(message.Data))
			if err := publish(dir, "messages.json", map[string]any{"messages": messages, "local": pair.Local.Typ.String(), "remote": pair.Remote.Typ.String()}); err != nil {
				reportFailure(err)
				return
			}
			if err := dc.SendText(string(message.Data)); err != nil {
				reportFailure(err)
			}
		})
	})
	if err = pc.SetRemoteDescription(cfg.Offer); err != nil {
		return err
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return err
	}
	done := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(answer); err != nil {
		return err
	}
	select {
	case <-done:
	case err := <-asyncErrors:
		return err
	case <-time.After(20 * time.Second):
		return errors.New("ICE gathering timed out")
	}
	if err = publish(dir, "answer.json", pc.LocalDescription()); err != nil {
		return err
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	select {
	case <-signals:
		return nil
	case err := <-asyncErrors:
		return err
	case <-time.After(90 * time.Second):
		return errors.New("peer lifetime exceeded")
	}
}
func main() {
	if len(os.Args) != 2 {
		os.Exit(2)
	}
	if err := run(os.Args[1]); err != nil {
		_ = publish(os.Args[1], "failure.json", map[string]string{"error": fmt.Sprint(err)})
		os.Exit(1)
	}
}
