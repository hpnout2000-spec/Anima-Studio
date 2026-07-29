const https = require('https');
https.get('https://animadex.net/?mode=characters', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    const links = data.match(/<a[^>]*href=["'][^"']*["'][^>]*>[\s\S]*?<\/a>/gi) || [];
    console.log(links.slice(0, 15).join('\n'));
    console.log("----- CARDS -----");
    const cards = data.match(/<article[^>]*>[\s\S]*?<\/article>/gi) || [];
    console.log(cards.slice(0, 2).join('\n'));
  });
});
