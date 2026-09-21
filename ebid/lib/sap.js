'use strict';
// SAP OData client + operations. Endpoints & payloads preserved EXACTLY from
// the original working script so live bids keep succeeding.
const axios = require('axios');
const { HttpsCookieAgent } = require('http-cookie-agent/http');
const { CookieJar } = require('tough-cookie');
const tu = require('./timeutil');

// Keep NODE_TLS_REJECT_UNAUTHORIZED behaviour as the original (self-signed cert).
// SECURITY: ideally install a proper CA cert; flagged in README.
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED == null) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const SRV = '/sap/opu/odata/sap/ZVC_TRANSPORTER_SRV';

class SapClient {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.csrfToken = null;
    this.clockOffset = 0;      // ms to add to Date.now() -> SAP server time
    this.plantConf = null;
    this.bidRows = [];
    this.orderListData = null;

    // Pre-warmed keep-alive + cookie-aware agent: TLS handshake reused for the
    // whole run, and the session cookie rides along automatically.
    const jar = new CookieJar();
    this.jar = jar;
    this.agent = new HttpsCookieAgent({
      cookies: { jar },
      keepAlive: true,
      maxSockets: 8,
      rejectUnauthorized: false,
    });
    this.client = axios.create({
      baseURL: cfg.BASE_URL,
      withCredentials: true,
      httpsAgent: this.agent,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        // Browser-like UA: some WAFs (this SAP sits behind AppTrana) flag the
        // default "axios/x.y" agent as suspicious. Harmless on whitelisted IPs.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      auth: { username: cfg.USER_ID, password: cfg.PASSWORD },
      maxRedirects: 10,
      timeout: 30000,
    });
  }

  _syncClock(resp) {
    try {
      const dh = resp && resp.headers && resp.headers.date;
      if (dh) this.clockOffset = tu.offsetFromHttpDate(dh, Date.now());
    } catch (_) {}
  }

  serverNow() { return tu.serverNow(this.clockOffset); }

  async login() {
    try {
      const r = await this.client.get(SRV + '/', { headers: { 'X-Csrf-Token': 'Fetch' } });
      this._syncClock(r);
      this.csrfToken = r.headers['x-csrf-token'];
      if (!this.csrfToken) {
        const r2 = await this.client.get(SRV + "/SessionSet('')", { headers: { 'X-Csrf-Token': 'Fetch' } });
        this._syncClock(r2);
        this.csrfToken = r2.headers['x-csrf-token'];
      }
      if (!this.csrfToken) throw new Error('Could not obtain CSRF token');
      this.log.ok(`Login OK, CSRF ${this.csrfToken.substring(0, 12)}... clockOffset=${this.clockOffset}ms`);
      return true;
    } catch (e) {
      if (e.response && e.response.headers['x-csrf-token']) {
        this.csrfToken = e.response.headers['x-csrf-token'];
        this.log.warn('Got CSRF despite error');
        return true;
      }
      this.log.err('Login failed: ' + (e.response ? e.response.status : e.message));
      return false;
    }
  }

  async refreshCsrf() {
    try {
      const r = await this.client.get(SRV + '/', { headers: { 'X-Csrf-Token': 'Fetch' } });
      this._syncClock(r);
      if (r.headers['x-csrf-token']) {
        this.csrfToken = r.headers['x-csrf-token'];
        return true;
      }
    } catch (e) {
      if (e.response && e.response.headers['x-csrf-token']) {
        this.csrfToken = e.response.headers['x-csrf-token'];
        return true;
      }
    }
    return false;
  }

  _orderListPayload() {
    return {
      IvStatus: '', IvBiddingStatus: '2',
      NavBidSchVendors: [], NavBidMessage: [], NavBidPlntConf: [],
      NavBidCurrDtDm: { CurrDate: '/Date(1467981296000)/', CurrTime: null },
      NavBidToler: [], NavBidTolerence: [], EvTolerenceAmount: '', EvFrieghtPercent: '',
      IvBidBiddingPlantFlag: '', NavBidStoIdRange: [], NavBidClubId: [], NavBidErdatRange: [],
      NavBidShipToVkburRange: [], NavBidBiddingPlant: [], NavBidBgpRange: [], NavBidPackRange: [],
      NavBidKunweRange: [],
      NavBidVendorRange: [{ Sign: 'I', Option: 'EQ', Low: this.cfg.USER_ID, High: '' }],
      NavBidSapOrderIdRange: [], NavBidKunagRange: [], NavBidBrandRange: [], NavBidApplAreaRange: [],
      NavBidVendorStatus: [{ Sign: 'I', Option: 'EQ', Low: '1', High: '' }],
      NavBidShipFromWerksRange: [{ Sign: 'I', Option: 'EQ', Low: this.cfg.PLANT, High: '' }],
      NavBidSapStoIdRange: [], NavBidGradeRange: [], NavBidOrderIdRange: [], NavBidStateRange: [],
    };
  }

  async fetchOrders() {
    try {
      const r = await this.client.post(SRV + '/BidOrderListSet', this._orderListPayload(),
        { headers: { 'X-Csrf-Token': this.csrfToken } });
      this._syncClock(r);
      const d = r.data.d;
      this.orderListData = d;
      this.plantConf = d.NavBidPlntConf.results[0] || null;
      this.bidRows = d.NavBidSchVendors.results || [];
      for (const row of this.bidRows) {
        row.BiddingAmount = Number(row.BiddingAmount).toFixed();
        row.Freight = Number(row.Freight).toFixed();
        row.ClubFreight = Number(row.ClubFreight).toFixed();
        row.L1BidAmount = Number(row.L1BidAmount).toFixed();
        row.AvgWtBidAmount = Number(row.AvgWtBidAmount).toFixed();
        row.NoOfTruckReq = String(row.NoOfTruckReq);
      }
      this.log.ok(`Fetched ${this.bidRows.length} orders`);
      return true;
    } catch (e) {
      const msg = e.response && e.response.data && e.response.data.error
        ? e.response.data.error.message.value : e.message;
      this.log.err('fetchOrders failed: ' + msg);
      return false;
    }
  }

  // Returns base64 image string, or null. quiet=true suppresses logs (for polling).
  async fetchCaptcha(quiet = false) {
    try {
      const plant = this.plantConf ? this.plantConf.Plant : this.cfg.PLANT;
      const url = SRV + `/EbiddingCaptchaSet(Vendor='${this.cfg.USER_ID}',Plant='${plant}')`;
      const r = await this.client.get(url, { headers: { 'X-Csrf-Token': this.csrfToken } });
      const img = r.data.d.ImageString;
      if (img && !quiet) this.log.ok(`Captcha image (${img.length} chars)`);
      return img || null;
    } catch (e) {
      if (!quiet) this.log.err('fetchCaptcha error: ' + e.message);
      return null;
    }
  }

  // Build the EBiddingSaveSet payload for a list of matched rows.
  // NOTE: Freight/ClubFreight mapping is intentionally the SAME swap as the
  // original working script — do not "fix" it or live bids may break.
  buildPayload(matchedRows, captchaValue) {
    const p = { Flag: '1', Ev_Text: '', NavEBiddingTrackHis: [], NavEBiddingMessage: {}, IvCaptchaValue: captchaValue };
    for (const mr of matchedRows) {
      const it = mr.item;
      p.NavEBiddingTrackHis.push({
        Mandt: '', SapOrderId: it.SapOrderId, Vendor: this.cfg.USER_ID, ChangeNo: '',
        ShipFromWerks: it.ShipFromWerks,
        BiddingDate: this.plantConf.BiddingDate, SlotNumber: this.plantConf.SlotNumber,
        Freight: (it.ClubFreight || 0) + '.000',       // preserved swap
        ClubId: it.ClubId || '',
        ClubFreight: (it.Freight || 0) + '.000',        // preserved swap
        BiddingAmount: (mr.bidAmount || 0) + '.000',
        BiddingRank: it.BiddingRank,
        AvgWtBidAmount: (mr.bidAmount || 0) + '.000',
        CreatedOn: null, CreatedAt: null,
      });
    }
    return p;
  }

  // Submit one batch. Returns { type: 'S'|'E'|'I'|'N', message }.
  async submit(matchedRows, captchaValue, dryRun = false) {
    const payload = this.buildPayload(matchedRows, captchaValue);
    if (dryRun) return { type: 'DRY', message: 'dry-run', rows: payload.NavEBiddingTrackHis.length };
    try {
      const r = await this.client.post(SRV + '/EBiddingSaveSet', payload,
        { headers: { 'X-Csrf-Token': this.csrfToken } });
      this._syncClock(r);
      const d = (r.data && r.data.d) ? r.data.d : {};
      const m = d.NavEBiddingMessage || {};
      const text = (d.Ev_Text || m.Message || '').replace(/#/g, '\n').replace(/0/g, '').trim();
      if (m.Type === 'S') return { type: 'S', message: text };
      if (m.Type === 'E') return { type: 'E', message: text };
      if (m.Type === 'I') return { type: 'I', message: text };
      return { type: 'N', message: 'no change' };
    } catch (e) {
      const msg = e.response && e.response.data && e.response.data.error
        ? e.response.data.error.message.value : e.message;
      // 403 usually = stale CSRF; signal caller to refresh.
      const status = e.response ? e.response.status : 0;
      return { type: 'E', message: msg, status };
    }
  }
}

module.exports = { SapClient, SRV };
