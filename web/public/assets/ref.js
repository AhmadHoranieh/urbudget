// Carries the tag a link to this page came with on to its download links, so the Worker can count
// downloads per tag. Links from other sites use the query (urbudget.app/download/?ref=hn); the
// site's own Download buttons use the fragment (/download/#ref=vs-ynab), which crawlers ignore, so
// they don't see a separate page per button. Nothing is stored anywhere: the tag only travels in
// the URL. Any page can include this; it touches only links to /download/.

const ref =
  new URLSearchParams(location.search).get("ref") ?? new URLSearchParams(location.hash.slice(1)).get("ref");
if (ref) {
  for (const link of document.querySelectorAll('a[href^="/download/"]')) {
    const url = new URL(link.href);
    url.searchParams.set("ref", ref);
    link.href = url.pathname + url.search + url.hash;
  }
}
