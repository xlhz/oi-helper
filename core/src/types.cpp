#include "oi/types.h"

namespace oi {

std::string statusToString(Status s) {
    switch (s) {
        case Status::AC: return "AC";
        case Status::WA: return "WA";
        case Status::TLE: return "TLE";
        case Status::MLE: return "MLE";
        case Status::RE: return "RE";
        case Status::CE: return "CE";
    }
    return "RE";
}

std::string problemTypeToString(ProblemType t) {
    switch (t) {
        case ProblemType::Traditional: return "traditional";
        case ProblemType::Interactive: return "interactive";
        case ProblemType::OutputOnly: return "output-only";
        case ProblemType::Communication: return "communication";
    }
    return "traditional";
}

ProblemType problemTypeFromString(const std::string& s) {
    if (s == "interactive") return ProblemType::Interactive;
    if (s == "output-only" || s == "outputonly" || s == "output_only") return ProblemType::OutputOnly;
    if (s == "communication") return ProblemType::Communication;
    return ProblemType::Traditional;
}

}  // namespace oi
