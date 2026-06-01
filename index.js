const https = require('https');
const http  = require('http');
const tls   = require('tls');
const net   = require('net');

const CONFIG = {
  EVENT_ID:      '161010371',
  INTERVAL:      5 * 60 * 1000,
  TG_TOKEN:      '8966081803:AAF-79yIhvvbnENBAZuwAHLUEB1-LqW_3GI',
  TG_CHAT_ID:    '1019501940',
  INITIAL_STOCK: 4481,
  COOKIE:        'd=XLlgG64Y3gGIlMh55LZzQpz8XjJ9P3KPrsv4SA2; sel=p; p=eyJfX3R5cGUiOiJWaWFnb2dvLklkZW50aXR5U2VydmljZS5Qcm9maWxlLCBWaWFnb2dvLklkZW50aXR5U2VydmljZSIsInUiOiJCcnVubyBOdW5lcyIsImwiOjIwNTcsImMiOm51bGx90; auths=1; _userCurrencyCode=EUR; rskxRunCookie=0; rCookie=fqtqj4zsk3qhoijz87u5qtmkj2ren3; ctattr=AQEBl8NP1g2; s=cmhr4YYO50Sj91wl18s2vFxiCjuNud4I0;',
  PROXY: {
    host: 'premium.flamingoproxies.com',
    port: 61236,
    user: 'W52JQM5BIKSCVTE-country-pt',
    pass: 'B93T43DFDANR75Y',
  }
};

let knownSales        = new Set();
let sessionSales      = [];
let isFirst           = true;
let checkCount        = 0;
let lastDashboardHour = -1;

function sendTelegram(msg) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: CONFIG.TG_CHAT_ID, text: msg, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + CONFIG.TG_TOKEN + '/sendMessage',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', e => { console.error('[Telegram] Erro:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

function fetchMarketData() {
  return new Promise((resolve, reject) => {
    const postBody   = 'eventId=' + CONFIG.EVENT_ID + '&latestServerStamp=0';
    const proxyAuth  = Buffer.from(CONFIG.PROXY.user + ':' + CONFIG.PROXY.pass).toString('base64');

    // Step 1: TCP connect to proxy
    const socket = net.connect(CONFIG.PROXY.port, CONFIG.PROXY.host, () => {
      // Step 2: Send CONNECT
      socket.write(
        'CONNECT inv.viagogo.com:443 HTTP/1.1\r\n' +
        'Host: inv.viagogo.com:443\r\n' +
        'Proxy-Authorization: Basic ' + proxyAuth + '\r\n' +
        '\r\n'
      );
    });

    socket.on('error', reject);

    let proxyResponse = '';
    socket.on('data', (chunk) => {
      proxyResponse += chunk.toString();
      if (!proxyResponse.includes('\r\n\r\n')) return;

      if (!proxyResponse.includes('200')) {
        reject(new Error('Proxy CONNECT falhou: ' + proxyResponse.split('\r\n')[0]));
        socket.destroy();
        return;
      }

      // Step 3: TLS upgrade
      const tlsSocket = tls.connect({
        socket,
        servername: 'inv.viagogo.com',
        rejectUnauthorized: false,
      }, () => {
        // Step 4: Send HTTPS POST
        const request =
          'POST /Listings/MarketDataV3 HTTP/1.1\r\n' +
          'Host: inv.viagogo.com\r\n' +
          'Content-Type: application/x-www-form-urlencoded; charset=UTF-8\r\n' +
          'Content-Length: ' + Buffer.byteLength(postBody) + '\r\n' +
          'X-Requested-With: XMLHttpRequest\r\n' +
          'Cookie: ' + CONFIG.COOKIE + '\r\n' +
          'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36\r\n' +
          'Referer: https://inv.viagogo.com/Listings\r\n' +
          'Origin: https://inv.viagogo.com\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          postBody;

        tlsSocket.write(request);
      });

      let responseData = Buffer.alloc(0);
      tlsSocket.on('data', chunk => {
        responseData = Buffer.concat([responseData, chunk]);
      });
      tlsSocket.on('end', () => {
        const response = responseData.toString();
        const headerEnd = response.indexOf('\r\n\r\n');
        if (headerEnd === -1) { resolve(response); return; }
        const body = response.substring(headerEnd + 4);
        resolve(body);
      });
      tlsSocket.on('error', reject);
    });
  });
}

function parseSales(html) {
  const sales = [];
  const gridMatch = html.match(/id="marketTransactionsGrid"[\s\S]*?<\/div>\s*<\/div>/);
  if (!gridMatch) return sales;
  const rows = gridMatch[0].split('<tr class="');
  rows.forEach(row => {
    if (!row.includes('txtl')) return;
    const tdMatches = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
    if (tdMatches.length < 6) return;
    const getText = td => td.replace(/<[^>]+>/g, '').trim();
    const section   = getText(tdMatches[1][1]);
    const rowNum    = getText(tdMatches[2][1]);
    const seats     = getText(tdMatches[3][1]);
    const qty       = getText(tdMatches[4][1]);
    const priceText = getText(tdMatches[5][1]);
    const price     = parseFloat(priceText.replace('€', ''));
    if (section && !isNaN(price)) {
      sales.push({ section, row: rowNum, seats, qty: parseInt(qty)||0, price, priceText });
    }
  });
  return sales;
}

function saleKey(s) { return s.section+'|'+s.row+'|'+s.seats+'|'+s.qty+'|'+s.priceText; }

function getStats() {
  const now        = new Date();
  const last1h     = new Date(now - 3600000);
  const last24h    = new Date(now - 86400000);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const qtyLast1h  = sessionSales.filter(s => s.ts >= last1h).reduce((a,s) => a+s.qty, 0);
  const qtyLast24h = sessionSales.filter(s => s.ts >= last24h).reduce((a,s) => a+s.qty, 0);
  const qtyToday   = sessionSales.filter(s => s.ts >= todayStart).reduce((a,s) => a+s.qty, 0);
  const sectorMap  = {};
  sessionSales.forEach(s => { sectorMap[s.section] = (sectorMap[s.section]||0)+s.qty; });
  const topSector  = Object.entries(sectorMap).sort((a,b) => b[1]-a[1])[0];
  const totalSold  = sessionSales.reduce((a,s) => a+s.qty, 0);
  const estimated  = Math.round((CONFIG.INITIAL_STOCK - totalSold) / 100) * 100;
  return { qtyLast1h, qtyLast24h, qtyToday, topSector, estimated, totalSold };
}

async function sendDashboard(label) {
  const now     = new Date();
  const s       = getStats();
  const timeStr = now.toLocaleTimeString('pt-PT', { hour:'2-digit', minute:'2-digit' });
  const dateStr = now.toLocaleDateString('pt-PT', { weekday:'long', day:'2-digit', month:'2-digit' });
  const topLine = s.topSector
    ? '🏆 Sector mais vendido: <b>'+s.topSector[0]+'</b> ('+s.topSector[1]+' bilhetes)'
    : '🏆 Sector mais vendido: sem dados ainda';
  await sendTelegram(
    '📊 <b>Dashboard '+label+'</b>\n'+
    '🗓 '+dateStr+' — '+timeStr+'\n'+
    '━━━━━━━━━━━━━━━━━\n'+
    '🎟 Vendidos hoje: <b>'+s.qtyToday+'</b>\n'+
    '⏱ Últimas 24h: <b>'+s.qtyLast24h+'</b>\n'+
    '🔥 Última hora: <b>'+s.qtyLast1h+'</b>\n'+
    topLine+'\n'+
    '━━━━━━━━━━━━━━━━━\n'+
    '📦 Stock estimado: <b>~'+s.estimated+'</b> bilhetes\n'+
    '📉 Vendidos desde início: <b>'+s.totalSold+'</b>'
  );
  console.log('[Monitor] Dashboard enviado — '+timeStr);
}

async function poll() {
  checkCount++;
  const now    = new Date();
  const nowStr = now.toLocaleTimeString('pt-PT');
  try {
    const html  = await fetchMarketData();
    console.log('[Debug] length:', html.length, 'first 200:', html.substring(0,200).replace(/\n/g,' '));

    const sales = parseSales(html);

    if (sales.length === 0 && html.length < 500) {
      console.warn('[Monitor] Resposta suspeita.');
      await sendTelegram('⚠️ <b>Aviso</b>: Resposta inválida. Sessão pode ter expirado.');
      return;
    }

    const newSales = [];
    sales.forEach(s => {
      const k = saleKey(s);
      if (!knownSales.has(k)) {
        knownSales.add(k);
        if (!isFirst) { s.ts = now; newSales.push(s); sessionSales.push(s); }
      }
    });

    if (isFirst) {
      console.log('[Monitor] Iniciado às '+nowStr+'. Baseline: '+sales.length+' transacções.');
      await sendTelegram(
        '🟢 <b>Monitor iniciado (cloud + proxy PT)</b>\n'+
        'Portugal vs Chile — '+nowStr+'\n'+
        'Baseline: '+sales.length+' transacções.\n'+
        'Stock referência: '+CONFIG.INITIAL_STOCK+' bilhetes\n'+
        '✅ A correr 24/7 — check a cada 5 minutos'
      );
      isFirst = false;
    } else if (newSales.length > 0) {
      console.log('[Monitor] '+nowStr+' — '+newSales.length+' venda(s) nova(s)!');
      for (const s of newSales) {
        const stats = getStats();
        await sendTelegram(
          '🎟 <b>Venda detectada!</b>\n'+
          '━━━━━━━━━━━━━━\n'+
          '📍 Secção: <b>'+s.section+'</b>  |  Fila: <b>'+s.row+'</b>\n'+
          '💺 Lugares: '+(s.seats||'—')+'\n'+
          '🔢 Quantidade: <b>'+s.qty+'</b>\n'+
          '💶 Preço: <b>'+s.priceText+'</b>\n'+
          '🕐 '+nowStr+'\n'+
          '📦 Stock estimado: ~'+stats.estimated
        );
      }
    } else {
      console.log('[Monitor] '+nowStr+' (check #'+checkCount+') — sem novas vendas.');
    }

    const currentHour = now.getHours();
    if (currentHour !== lastDashboardHour && !isFirst) {
      lastDashboardHour = currentHour;
      await sendDashboard('horário');
    }

  } catch(e) {
    console.error('[Monitor] Erro no check #'+checkCount+':', e.message);
  }
}

console.log('[Monitor] A arrancar com proxy PT (TLS directo)...');
poll();
setInterval(poll, CONFIG.INTERVAL);
