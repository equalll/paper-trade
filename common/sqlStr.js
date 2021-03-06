/**
 * 生成sql语句
 * @param value 要操作的对象
 * @param other 要覆盖的名称，键为字段名，值为要覆盖的sql参数名,值为空则删除操作对象中的属性名
 */
function getNames(value, other) {
    let names = Object.keys(value);
    let argNames = names.map(n => ':' + n);
    let others = []
    if (other) {
        if (Array.isArray(other)) {
            others = other
        } else if (typeof other == "string") {
            others.push("(" + other + ")")
        } else
            for (let n in other) {
                let i = names.indexOf(n)
                if (other[n]) {
                    if (i != -1) {
                        argNames[i] = other[n]
                    } else {
                        names.push(n)
                        argNames.push(other[n])
                    }
                } else {
                    if (i != -1) {
                        names.splice(i, 1)
                        argNames.splice(i, 1)
                    }
                }
            }
    }

    let equres = names.map((n, i) => n + "=" + argNames[i]).concat(others)
    names = names.join(",")
    argNames = argNames.join(",")
    return { names, argNames, equres }
}
export default {
    select2(table, value, other, option) {
        if (!value) value = {}
        let replacements = value
        if (!option) option = { replacements, type: "SELECT" }
        else Object.assign(option, { replacements, type: "SELECT" })
        let { equres } = getNames(value, other)
        return [`select * from ${table} where ${equres.join(" and ")}`, option]
    },
    delete2(table, value, other, option) {
        let replacements = value
        if (!option) option = { replacements }
        else Object.assign(option, { replacements })
        let { equres } = getNames(value, other)
        return [`delete from ${table} where ${equres.join(" and ")}`, option]
    },
    insert(table, value, other) {
        let { names, argNames } = getNames(value, other)
        return `insert into ${table}(${names}) values(${argNames}) `
    },
    insert2(table, value, other, option) {
        if (!option) option = { replacements: value }
        else Object.assign(option, { replacements: value })
        return [this.insert(table, value, other), option]
    },
    update(table, value, other, where = "") {
        let { equres } = getNames(value, other)
        return `update ${table} set ${equres.join(",")} ${where}`
    },
    update2(table, value, other, where = "", option) {
        let replacements = value
        if (typeof where == 'object') {
            replacements = Object.assign(Object.assign({}, where), value)
            where = "where " + Object.keys(where).map(n => `${n}=:${n}`).join(" and ")
        }
        if (!option) option = { replacements }
        else Object.assign(option, { replacements })
        return [this.update(table, value, other, where), option]
    }
}