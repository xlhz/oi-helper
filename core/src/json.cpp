#include "oi/json.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <sstream>

namespace oi {

namespace {
const Json kNullJson;
}

Json Json::makeObject() {
    Json j;
    j.type = Type::Object;
    return j;
}

Json Json::makeArray() {
    Json j;
    j.type = Type::Array;
    return j;
}

Json Json::makeString(const std::string& s) {
    Json j;
    j.type = Type::String;
    j.strVal = s;
    return j;
}

Json Json::makeInt(long long v) {
    Json j;
    j.type = Type::Number;
    j.isInt = true;
    j.intVal = v;
    j.numVal = static_cast<double>(v);
    return j;
}

Json Json::makeNumber(double v) {
    Json j;
    j.type = Type::Number;
    j.isInt = false;
    j.numVal = v;
    return j;
}

Json Json::makeBool(bool v) {
    Json j;
    j.type = Type::Bool;
    j.boolVal = v;
    return j;
}

bool Json::contains(const std::string& key) const {
    return type == Type::Object && objVal.find(key) != objVal.end();
}

const Json& Json::operator[](const std::string& key) const {
    if (type == Type::Object) {
        auto it = objVal.find(key);
        if (it != objVal.end()) return it->second;
    }
    return kNullJson;
}

Json& Json::operator[](const std::string& key) {
    if (type != Type::Object) {
        type = Type::Object;
        objVal.clear();
    }
    return objVal[key];
}

const Json& Json::at(size_t index) const {
    if (type == Type::Array && index < arrVal.size()) return arrVal[index];
    return kNullJson;
}

size_t Json::size() const {
    if (type == Type::Array) return arrVal.size();
    if (type == Type::Object) return objVal.size();
    return 0;
}

std::string Json::getString(const std::string& def) const {
    return type == Type::String ? strVal : def;
}

long long Json::getInt(long long def) const {
    if (type != Type::Number) return def;
    return isInt ? intVal : static_cast<long long>(numVal);
}

double Json::getDouble(double def) const {
    if (type != Type::Number) return def;
    return isInt ? static_cast<double>(intVal) : numVal;
}

bool Json::getBool(bool def) const {
    return type == Type::Bool ? boolVal : def;
}

namespace {

void escapeString(const std::string& s, std::string& out) {
    out.push_back('"');
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back(static_cast<char>(c));
                }
        }
    }
    out.push_back('"');
}

void numberToString(const Json& j, std::string& out) {
    if (j.isInt) {
        out += std::to_string(j.intVal);
    } else {
        double v = j.numVal;
        if (v == static_cast<long long>(v) && std::fabs(v) < 1e15) {
            out += std::to_string(static_cast<long long>(v));
        } else {
            char buf[64];
            std::snprintf(buf, sizeof(buf), "%.17g", v);
            out += buf;
        }
    }
}

}  // namespace

void Json::dumpTo(std::string& out, bool pretty, int depth) const {
    auto indent = [&](int d) {
        if (pretty) {
            out.push_back('\n');
            out.append(static_cast<size_t>(d) * 2, ' ');
        }
    };
    switch (type) {
        case Type::Null: out += "null"; break;
        case Type::Bool: out += boolVal ? "true" : "false"; break;
        case Type::Number: numberToString(*this, out); break;
        case Type::String: escapeString(strVal, out); break;
        case Type::Array: {
            if (arrVal.empty()) { out += "[]"; break; }
            out.push_back('[');
            for (size_t i = 0; i < arrVal.size(); ++i) {
                if (i) out.push_back(',');
                indent(depth + 1);
                arrVal[i].dumpTo(out, pretty, depth + 1);
            }
            indent(depth);
            out.push_back(']');
            break;
        }
        case Type::Object: {
            if (objVal.empty()) { out += "{}"; break; }
            out.push_back('{');
            bool first = true;
            for (const auto& kv : objVal) {
                if (!first) out.push_back(',');
                first = false;
                indent(depth + 1);
                escapeString(kv.first, out);
                out.push_back(':');
                if (pretty) out.push_back(' ');
                kv.second.dumpTo(out, pretty, depth + 1);
            }
            indent(depth);
            out.push_back('}');
            break;
        }
    }
}

std::string Json::dump(bool pretty) const {
    std::string out;
    dumpTo(out, pretty, 0);
    return out;
}

namespace {

struct Parser {
    const std::string& s;
    size_t pos = 0;
    std::string err;

    explicit Parser(const std::string& text) : s(text) {}

    void skipWs() {
        while (pos < s.size()) {
            char c = s[pos];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                ++pos;
            } else {
                break;
            }
        }
    }

    bool fail(const std::string& msg) {
        if (err.empty()) {
            err = msg + " at offset " + std::to_string(pos);
        }
        return false;
    }

    bool parseValue(Json& out) {
        skipWs();
        if (pos >= s.size()) return fail("unexpected end");
        char c = s[pos];
        if (c == '{') return parseObject(out);
        if (c == '[') return parseArray(out);
        if (c == '"') {
            out = Json::makeString("");
            return parseString(out.strVal);
        }
        if (c == 't' || c == 'f') return parseBool(out);
        if (c == 'n') return parseNull(out);
        return parseNumber(out);
    }

    bool parseObject(Json& out) {
        out = Json::makeObject();
        ++pos;  // {
        skipWs();
        if (pos < s.size() && s[pos] == '}') { ++pos; return true; }
        while (true) {
            skipWs();
            if (pos >= s.size() || s[pos] != '"') return fail("expected key string");
            std::string key;
            if (!parseString(key)) return false;
            skipWs();
            if (pos >= s.size() || s[pos] != ':') return fail("expected ':'");
            ++pos;
            Json val;
            if (!parseValue(val)) return false;
            out.objVal[key] = std::move(val);
            skipWs();
            if (pos >= s.size()) return fail("unterminated object");
            if (s[pos] == ',') { ++pos; continue; }
            if (s[pos] == '}') { ++pos; return true; }
            return fail("expected ',' or '}'");
        }
    }

    bool parseArray(Json& out) {
        out = Json::makeArray();
        ++pos;  // [
        skipWs();
        if (pos < s.size() && s[pos] == ']') { ++pos; return true; }
        while (true) {
            Json val;
            if (!parseValue(val)) return false;
            out.arrVal.push_back(std::move(val));
            skipWs();
            if (pos >= s.size()) return fail("unterminated array");
            if (s[pos] == ',') { ++pos; continue; }
            if (s[pos] == ']') { ++pos; return true; }
            return fail("expected ',' or ']'");
        }
    }

    bool parseString(std::string& out) {
        ++pos;  // opening quote
        out.clear();
        while (pos < s.size()) {
            char c = s[pos++];
            if (c == '"') return true;
            if (c == '\\') {
                if (pos >= s.size()) return fail("bad escape");
                char e = s[pos++];
                switch (e) {
                    case '"': out.push_back('"'); break;
                    case '\\': out.push_back('\\'); break;
                    case '/': out.push_back('/'); break;
                    case 'n': out.push_back('\n'); break;
                    case 'r': out.push_back('\r'); break;
                    case 't': out.push_back('\t'); break;
                    case 'b': out.push_back('\b'); break;
                    case 'f': out.push_back('\f'); break;
                    case 'u': {
                        if (pos + 4 > s.size()) return fail("bad \\u escape");
                        unsigned code = 0;
                        for (int i = 0; i < 4; ++i) {
                            char h = s[pos++];
                            code <<= 4;
                            if (h >= '0' && h <= '9') code |= static_cast<unsigned>(h - '0');
                            else if (h >= 'a' && h <= 'f') code |= static_cast<unsigned>(h - 'a' + 10);
                            else if (h >= 'A' && h <= 'F') code |= static_cast<unsigned>(h - 'A' + 10);
                            else return fail("bad hex digit");
                        }
                        if (code < 0x80) {
                            out.push_back(static_cast<char>(code));
                        } else if (code < 0x800) {
                            out.push_back(static_cast<char>(0xC0 | (code >> 6)));
                            out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
                        } else {
                            out.push_back(static_cast<char>(0xE0 | (code >> 12)));
                            out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
                            out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
                        }
                        break;
                    }
                    default: return fail("unknown escape");
                }
            } else {
                out.push_back(c);
            }
        }
        return fail("unterminated string");
    }

    bool parseNumber(Json& out) {
        size_t start = pos;
        if (pos < s.size() && (s[pos] == '-' || s[pos] == '+')) ++pos;
        bool isFloat = false;
        while (pos < s.size()) {
            char c = s[pos];
            if (c >= '0' && c <= '9') {
                ++pos;
            } else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
                if (c == '.' || c == 'e' || c == 'E') isFloat = true;
                ++pos;
            } else {
                break;
            }
        }
        if (pos == start) return fail("invalid number");
        std::string tok = s.substr(start, pos - start);
        if (isFloat) {
            out = Json::makeNumber(std::strtod(tok.c_str(), nullptr));
        } else {
            out = Json::makeInt(std::strtoll(tok.c_str(), nullptr, 10));
        }
        return true;
    }

    bool parseBool(Json& out) {
        if (s.compare(pos, 4, "true") == 0) { pos += 4; out = Json::makeBool(true); return true; }
        if (s.compare(pos, 5, "false") == 0) { pos += 5; out = Json::makeBool(false); return true; }
        return fail("invalid literal");
    }

    bool parseNull(Json& out) {
        if (s.compare(pos, 4, "null") == 0) { pos += 4; out = Json(); return true; }
        return fail("invalid literal");
    }
};

}  // namespace

bool Json::parse(const std::string& text, Json& out, std::string& err) {
    Parser p(text);
    if (!p.parseValue(out)) {
        err = p.err;
        return false;
    }
    p.skipWs();
    if (p.pos != text.size()) {
        err = "trailing characters at offset " + std::to_string(p.pos);
        return false;
    }
    return true;
}

}  // namespace oi
