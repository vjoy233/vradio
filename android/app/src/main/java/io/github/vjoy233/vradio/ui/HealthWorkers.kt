package io.github.vjoy233.vradio.ui

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

// probeAll 的实际 worker；stop 只在取下一项前检查，在飞探测正常收尾。
internal suspend fun <T, R> runHealthWorkers(
  list: List<T>, conc: Int, stop: () -> Boolean, onProg: (Int, Int) -> Unit,
  probe: suspend (T) -> R
): List<Pair<T, R>> {
  val q = ConcurrentLinkedQueue(list)
  val out = ConcurrentLinkedQueue<Pair<T, R>>()
  val done = AtomicInteger(); val total = list.size
  coroutineScope {
    repeat(conc) {
      launch(Dispatchers.IO) {
        while (!stop()) {
          val s = q.poll() ?: return@launch
          out.add(s to probe(s))
          onProg(done.incrementAndGet(), total)
        }
      }
    }
  }
  return out.toList()
}
