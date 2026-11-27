package io.github.vjoy233.vradio.sync

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/** Default-off strict journal facility. It is not wired into Store/AppVm/SyncEngine/LightUpdate. */
internal object HealthRecoveryV1Codec {
  const val MAX_BYTES = 1024 * 1024
  const val MAX_DEPTH = 32
  const val MAX_STATIONS = 500
  const val MAX_SOURCES = 6
  const val MAX_STRING = 2048

  data class Station(val id: String, val sources: List<String>)
  data class Journal(val batchId: String, val oldHash: String, val targetHash: String,
                     val phase: String, val stations: List<Station>, val completed: List<String>)

  fun read(file: File): Journal {
    val bytes = file.inputStream().use { input ->
      val out = ByteArrayOutputStream(); val buf = ByteArray(8192)
      while (true) { val n = input.read(buf); if (n < 0) break
        require(out.size() + n <= MAX_BYTES) { "health journal exceeds $MAX_BYTES bytes" }
        out.write(buf, 0, n)
      }
      out.toByteArray()
    }
    val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
    return decode(text)
  }

  fun encode(j: Journal): String {
    validate(j)
    fun q(s: String): String = buildString { append('"'); s.forEach { c ->
      when (c) { '"' -> append("\\\""); '\\' -> append("\\\\"); '\n' -> append("\\n"); '\r' -> append("\\r"); '\t' -> append("\\t"); '\b' -> append("\\b"); '\u000c' -> append("\\f"); else -> { require(c.code >= 0x20); append(c) }
      }
    }; append('"') }
    fun arr(xs: List<String>) = xs.joinToString(",", "[", "]", transform = ::q)
    val stations = j.stations.joinToString(",", "[", "]") { "{\"id\":${q(it.id)},\"sources\":${arr(it.sources)}}" }
    return "{\"v\":1,\"batchId\":${q(j.batchId)},\"oldHash\":${q(j.oldHash)},\"targetHash\":${q(j.targetHash)},\"phase\":${q(j.phase)},\"stations\":$stations,\"completed\":${arr(j.completed)}}"
  }

  fun decode(text: String): Journal {
    val p = Parser(text); val root = p.objectValue(); p.ws(); require(p.atEnd()) { "trailing JSON" }
    require(root.keys == setOf("v", "batchId", "oldHash", "targetHash", "phase", "stations", "completed"))
    require(root.num("v") == 1L)
    val batch = root.str("batchId"); val old = root.str("oldHash"); val target = root.str("targetHash"); val phase = root.str("phase")
    val stations = root.arr("stations").map { (it as Parser.V.Obj).obj }.map { e -> Station(e.str("id"), e.arr("sources").map { it.strValue() }) }
    val completed = root.arr("completed").map { it.strValue() }
    val j = Journal(batch, old, target, phase, stations, completed); validate(j); return j
  }

  private fun validate(j: Journal) {
    require(j.batchId.matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))); require(j.oldHash.matches(Regex("[0-9a-f]{64}"))); require(j.targetHash.matches(Regex("[0-9a-f]{64}")))
    require(j.oldHash != j.targetHash); require(j.phase == "PREPARED" || j.phase == "PUBLISHED")
    require(j.stations.isNotEmpty() && j.stations.size <= MAX_STATIONS); require(j.completed.distinct().size == j.completed.size && j.completed.size <= MAX_STATIONS)
    val ids = HashSet<String>(); j.stations.forEach { s -> require(s.id.isNotBlank() && s.id.length <= MAX_STRING && ids.add(s.id)); require(s.sources.isNotEmpty() && s.sources.size <= MAX_SOURCES); require(s.sources.first() == s.id); s.sources.forEach { require(it.isNotBlank() && it.length <= MAX_STRING) } }
    j.completed.forEach { require(it.isNotBlank() && it.length <= MAX_STRING && it in ids) }
  }

  private class Parser(private val s: String) {
    var i = 0; fun ws() { while (i < s.length && s[i] in " \t\r\n") i++ }; fun atEnd() = i == s.length
    fun need(c: Char) { ws(); require(i < s.length && s[i++] == c) }
    fun string(): String { ws(); require(i < s.length && s[i++] == '"'); val b = StringBuilder(); while (i < s.length) { val c=s[i++]; if(c=='"') return b.toString(); require(c.code>=32); if(c!='\\'){b.append(c);continue}; require(i<s.length); when(val e=s[i++]){'"','\\','/'->b.append(e);'b'->b.append('\b');'f'->b.append('\u000c');'n'->b.append('\n');'r'->b.append('\r');'t'->b.append('\t');'u'->{require(i+4<=s.length); var n=0; repeat(4){val h=s[i++]; require(h in "0123456789abcdefABCDEF"); n=n*16+h.digitToInt(16)}; b.append(n.toChar())};else->error("escape")}}; error("string") }
    fun value(depth:Int): V { require(depth<=MAX_DEPTH); ws(); require(i<s.length); return when(s[i]){'{'->V.Obj(objectValue(depth+1));'['->V.Arr(arrayValue(depth+1));'"'->V.Str(string());'t'->{lit("true");V.Bool};'f'->{lit("false");V.Bool};'n'->{lit("null");V.Null};else->V.Num(number())} }
    fun objectValue(depth:Int=0): Obj { require(depth<=MAX_DEPTH); need('{'); val m=LinkedHashMap<String,V>(); ws(); if(i<s.length&&s[i]=='}'){i++;return Obj(m)}; while(true){val k=string();need(':');require(m.put(k,value(depth+1))==null);ws();if(i<s.length&&s[i]==','){i++;continue};need('}');return Obj(m)} }
    fun arrayValue(depth:Int):List<V>{require(depth<=MAX_DEPTH);need('[');val a=mutableListOf<V>();ws();if(i<s.length&&s[i]==']'){i++;return a};while(true){a+=value(depth+1);ws();if(i<s.length&&s[i]==','){i++;continue};need(']');return a}}
    fun lit(x:String){require(s.startsWith(x,i));i+=x.length}; fun number():Long{val st=i; if(s[i]=='-')i++;require(i<s.length);if(s[i]=='0'){i++}else{require(s[i] in '1'..'9');while(i<s.length&&s[i].isDigit())i++}; val end=i; return s.substring(st,end).toLong()};
    sealed class V{data class Str(val x:String):V();data class Obj(val obj: Parser.Obj):V();data class Arr(val x:List<V>):V();data class Num(val x:Long):V();data object Bool:V();data object Null:V();fun strValue()= (this as Str).x}
    data class Obj(val m:Map<String,V>){val keys get()=m.keys;fun str(k:String)=(m[k] as V.Str).x;fun num(k:String)=(m[k] as V.Num).x;fun arr(k:String)= (m[k] as V.Arr).x}
  }
}
