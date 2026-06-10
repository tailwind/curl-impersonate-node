/*
    Echo server run as a separate process: spawnSync in the tests blocks the
    test process's event loop, so an in-process server would deadlock against
    the curl child it is supposed to answer.

    Responds with JSON describing the request so tests can assert what curl
    actually sent. /large returns a 2MB body instead.
*/
import http from "node:http";

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    if (req.url?.startsWith("/large")) {
      res.end("x".repeat(2 * 1024 * 1024));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body,
      })
    );
  });
});

server.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({ port: server.address().port }));
});
