#pragma once
#include <map>
#include <string>
#include <vector>

namespace oi {

// 轻量 JSON: 自实现解析与序列化, 不引第三方
class Json {
public:
    enum class Type { Null, Bool, Number, String, Array, Object };

    Type type = Type::Null;
    bool boolVal = false;
    double numVal = 0;
    bool isInt = false;
    long long intVal = 0;
    std::string strVal;
    std::vector<Json> arrVal;
    std::map<std::string, Json> objVal;

    static Json makeObject();
    static Json makeArray();
    static Json makeString(const std::string& s);
    static Json makeInt(long long v);
    static Json makeNumber(double v);
    static Json makeBool(bool v);

    bool isNull() const { return type == Type::Null; }
    bool contains(const std::string& key) const;
    const Json& operator[](const std::string& key) const;
    Json& operator[](const std::string& key);
    const Json& at(size_t index) const;
    size_t size() const;
    const std::vector<Json>& items() const { return arrVal; }

    std::string getString(const std::string& def = "") const;
    long long getInt(long long def = 0) const;
    double getDouble(double def = 0) const;
    bool getBool(bool def = false) const;

    std::string dump(bool pretty = false) const;
    static bool parse(const std::string& text, Json& out, std::string& err);

private:
    void dumpTo(std::string& out, bool pretty, int depth) const;
};

}  // namespace oi
