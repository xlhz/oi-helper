#pragma once

namespace oi {

// 启动本地 HTTP 评测服务(阻塞运行), 监听 POST /judge; 端口无效返回非 0
int serveHttp(int port);

}  // namespace oi
