#pragma once
#include "oi/json.h"
#include "oi/types.h"

namespace oi {

// 评测编排入口; 按 problem.type 分发
JudgeResult runJudge(const JudgeTask& task);

// 评测结果转 JSON(CLI 与 REST 共用)
Json buildResultJson(const JudgeResult& res);

}  // namespace oi
