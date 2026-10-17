// Generates webhook signature test vectors with the exact logic of
// SignWebhook in server/internal/core/webhooks.go.
//
//	go run scripts/webhook_vectors.go > test/vectors/webhooks.json
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"time"
)

// SignWebhook is copied verbatim from server/internal/core/webhooks.go.
func SignWebhook(secret string, ts time.Time, body []byte) string {
	t := strconv.FormatInt(ts.Unix(), 10)
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(t + "."))
	m.Write(body)
	return "t=" + t + ",v1=" + hex.EncodeToString(m.Sum(nil))
}

type vector struct {
	Name   string `json:"name"`
	Secret string `json:"secret"`
	Body   string `json:"body"`
	Header string `json:"header"`
	Now    int64  `json:"now"`
}

func main() {
	secret := "whsec_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c"
	ts := time.Unix(1760600000, 0)
	// The server re-encodes the payload with encoding/json before signing.
	payload := map[string]any{
		"type":       "job.printed",
		"created_at": "2026-10-16T07:33:20Z",
		"org_id":     "34c4671b-d2ab-4ddf-aaac-615786d5acac",
		"data": map[string]any{"job": map[string]any{
			"id": "0b8a3f7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", "status": "printed", "title": "Order #1042 — café",
			"live": true, "copies": 1,
		}},
	}
	body, _ := json.Marshal(payload)
	unicode := []byte(`{"type":"job.created","data":{"job":{"title":"Ünïcødé ✓ 🐱"}},"org_id":"x","created_at":"2026-10-16T07:33:20Z"}`)
	out := []vector{
		{Name: "valid", Secret: secret, Body: string(body), Header: SignWebhook(secret, ts, body), Now: ts.Unix() + 10},
		{Name: "valid_unicode", Secret: secret, Body: string(unicode), Header: SignWebhook(secret, ts, unicode), Now: ts.Unix()},
		{Name: "valid_clock_skew_future", Secret: secret, Body: string(body), Header: SignWebhook(secret, ts.Add(120*time.Second), body), Now: ts.Unix()},
		{Name: "valid_at_tolerance_edge", Secret: secret, Body: string(body), Header: SignWebhook(secret, ts, body), Now: ts.Unix() + 300},
		{Name: "valid_multiple_v1", Secret: secret, Body: string(body),
			Header: SignWebhook("whsec_old_rotated_secret", ts, body) + ",v1=" + SignWebhook(secret, ts, body)[len("t=1760600000,v1="):], Now: ts.Unix()},
		{Name: "tampered", Secret: secret, Body: string(body[:len(body)-2]) + " }", Header: SignWebhook(secret, ts, body), Now: ts.Unix()},
		{Name: "expired", Secret: secret, Body: string(body), Header: SignWebhook(secret, ts, body), Now: ts.Unix() + 301},
		{Name: "wrong_secret", Secret: "whsec_not_the_right_one", Body: string(body), Header: SignWebhook(secret, ts, body), Now: ts.Unix()},
		{Name: "malformed_header", Secret: secret, Body: string(body), Header: "v1=deadbeef", Now: ts.Unix()},
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	_ = enc.Encode(out)
}
