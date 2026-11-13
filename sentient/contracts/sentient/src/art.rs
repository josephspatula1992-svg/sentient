//! The NFT's picture, drawn by the contract from the agent's genome, so the image a wallet shows is always the agent's
//! current genetics and status, with no image host to go missing. Five points, one per trait, joined into a shape: the
//! shape is the agent's temperament. A dormant agent is drawn grey.

use crate::genome::Genome;

// (cos, sin) * 1000 for five directions 72 degrees apart, starting straight up.
const DIRS: [(i32, i32); 5] = [(0, -1000), (951, -309), (588, 809), (-588, 809), (-951, -309)];

pub fn svg(id: u64, g: &Genome, dormant: bool) -> String {
    let hue = (id.wrapping_mul(137) % 360) as u32;
    let (sat_bg, sat_fg) = if dormant { (4, 6) } else { (30, 75) };
    let traits = g.to_array();
    let mut points = String::new();
    let mut dots = String::new();
    for (i, t) in traits.iter().enumerate() {
        let r = 12 + (*t as i32) * 36 / 100;
        let x = 50 + DIRS[i].0 * r / 1000;
        let y = 50 + DIRS[i].1 * r / 1000;
        if i > 0 {
            points.push(' ');
        }
        points.push_str(&format!("{x},{y}"));
        dots.push_str(&format!("<circle cx='{x}' cy='{y}' r='2.5'/>"));
    }
    format!(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>\
<rect width='100' height='100' fill='hsl({hue},{sat_bg}%,11%)'/>\
<circle cx='50' cy='50' r='46' fill='none' stroke='hsl({hue},{sat_bg}%,22%)'/>\
<polygon points='{points}' fill='hsl({hue},{sat_fg}%,55%)' fill-opacity='.30' stroke='hsl({hue},{sat_fg}%,65%)' stroke-width='1.2'/>\
<g fill='hsl({hue},{sat_fg}%,72%)'>{dots}</g>\
<circle cx='50' cy='50' r='4' fill='hsl({hue},{sat_fg}%,80%)'/></svg>"
    )
}

pub fn data_uri(id: u64, g: &Genome, dormant: bool) -> String {
    format!("data:image/svg+xml;utf8,{}", svg(id, g, dormant))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drawing_depends_on_genome_and_status() {
        let a = Genome::from_array([90, 10, 10, 10, 10]);
        let b = Genome::from_array([10, 90, 10, 10, 10]);
        assert_ne!(svg(1, &a, false), svg(1, &b, false));
        assert_ne!(svg(1, &a, false), svg(1, &a, true));
        assert_ne!(svg(1, &a, false), svg(2, &a, false));
        assert!(svg(1, &a, false).starts_with("<svg"));
        assert!(svg(1, &a, false).len() < 900);
    }
}
