// Generates the TLS certificates used by the local-printing unit tests:
// a self-signed station certificate (IP SAN 127.0.0.1), and a test CA with a
// leaf for a public-style station hostname. Test-only keys.
//
//	go run scripts/local_test_certs.go > test/fixtures/local-certs.json
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"time"
)

type pair struct {
	Cert        string `json:"cert"`
	Key         string `json:"key,omitempty"`
	Fingerprint string `json:"fingerprint"`
	Host        string `json:"host,omitempty"`
}

func mk(tpl, parent *x509.Certificate, pub *ecdsa.PublicKey, signer *ecdsa.PrivateKey, key *ecdsa.PrivateKey) (pair, *x509.Certificate) {
	der, err := x509.CreateCertificate(rand.Reader, tpl, parent, pub, signer)
	if err != nil {
		panic(err)
	}
	c, _ := x509.ParseCertificate(der)
	sum := sha256.Sum256(der)
	p := pair{Cert: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), Fingerprint: hex.EncodeToString(sum[:])}
	if key != nil {
		kb, _ := x509.MarshalPKCS8PrivateKey(key)
		p.Key = string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kb}))
	}
	return p, c
}

func main() {
	nb, na := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2126, 1, 1, 0, 0, 0, 0, time.UTC)
	k1, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	self := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "CatzPrint Station"}, NotBefore: nb, NotAfter: na,
		IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)}, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	selfP, _ := mk(self, self, &k1.PublicKey, k1, k1)

	k2, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	other := *self
	other.SerialNumber = big.NewInt(9)
	otherP, _ := mk(&other, &other, &k2.PublicKey, k2, k2)

	ck, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ca := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "CatzPrint Test CA"}, NotBefore: nb, NotAfter: na,
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caP, caC := mk(ca, ca, &ck.PublicKey, ck, nil)

	host := "127-0-0-1.abcdefghij.local.catzprint.com"
	lk, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	leaf := &x509.Certificate{SerialNumber: big.NewInt(3), Subject: pkix.Name{CommonName: host}, DNSNames: []string{host}, NotBefore: nb, NotAfter: na,
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	leafP, _ := mk(leaf, caC, &lk.PublicKey, ck, lk)
	leafP.Host = host

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(map[string]pair{"selfSigned": selfP, "otherSelfSigned": otherP, "ca": caP, "publicLeaf": leafP})
}
